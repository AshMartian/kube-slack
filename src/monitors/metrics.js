const EventEmitter = require('events');
const config = require('config');
const util = require('util');
const kube = require('../kube');

class PodMetrics extends EventEmitter {
	constructor() {
		super();
		this.alerted = {};
	}

	start() {
		// run an initial check right after the start instead of waiting for first interval to kick in.
		this.check();

		setInterval(() => {
			this.check();
		}, config.get('interval'));

		return this;
	}

	async check() {
		if (!kube.metricsEnabled) {
			return;
		}
		let pods = await kube.getWatchedPods();

		let percentageAlarm = config.get('metrics_alert')
			? config.get('metrics_alert') / 100
			: 0.8;
		for (let pod of pods) {
			this.messageProps = {};
			let annotations = pod.metadata.annotations;
			if (annotations) {
				// Ignore pod if the annotation is set and evaluates to true
				if (annotations['kube-slack/ignore-pod']) {
					continue;
				}

				if (annotations['kube-slack/slack-channel']) {
					this.messageProps['channel'] =
						annotations['kube-slack/slack-channel'];
				}
			}
			try {
				let metrics = await kube.getPodMetrics(pod);
				if (!metrics.body.containers || metrics.body.containers.length == 0) {
					continue;
				}
				for (let i = 0; i < metrics.body.containers.length; i++) {
					let podUsage = metrics.body.containers[i].usage;
					let podLimits = pod.spec.containers[i].resources.limits;
					if (!podLimits && config.get('metrics_requests')) {
						podLimits = pod.spec.containers[i].resources.requests;
					}

					Object.keys(podUsage).forEach(metric => {
						if (podLimits && podLimits[metric]) {
							this.checkMetric(
								metric,
								pod,
								podUsage[metric],
								podLimits[metric],
								percentageAlarm
							);
						}
					});
				}
			} catch (e) {
				continue;
			}
		}
	}

	checkMetric(type, pod, usage, limit, threshold) {
		if (config.get(`metrics_${type}`)) {
			let unit = unitMap[type] || '';
			let parsedUsage = parseKubeMetrics(usage);
			let parsedLimit = parseKubeMetrics(limit);
			let percentDifference = parsedUsage / parsedLimit;
			let podIdentifier = `${pod.metadata.namespace}-${pod.metadata.name}`;

			if (
				percentDifference > threshold &&
				!this.alerted[`${podIdentifier}-${type}`]
			) {
				//Send warning message
				this.emit('message', {
					fallback: `Container ${pod.metadata.namespace}/${
						pod.metadata.name
					} has high ${type} utilization`,
					color: 'danger',
					title: `${pod.metadata.namespace}/${pod.metadata.name}`,
					text: `Container ${type} usage above ${threshold *
						100}% threshold: *${parsedUsage} / ${parsedLimit}${unit}*`,
					mrkdwn_in: ['text'],
					_key: podIdentifier,
					...this.messageProps,
				});
				this.alerted[`${podIdentifier}-${type}`] = pod;
			} else if (
				percentDifference < threshold &&
				this.alerted[`${podIdentifier}-${type}`]
			) {
				//Send recovery message
				delete this.alerted[`${podIdentifier}-${type}`];
				this.emit('message', {
					fallback: `Container ${pod.metadata.namespace}/${
						pod.metadata.name
					} has normal ${type} utilization`,
					color: 'good',
					title: `${pod.metadata.namespace}/${pod.metadata.name}`,
					text: `Container ${type} at safe value *${parsedUsage} / ${parsedLimit}${unit}*`,
					mrkdwn_in: ['text'],
					_key: podIdentifier + '-recovery',
					...this.messageProps,
				});
			}
		}
	}
}

var parseKubeMetrics = metricValue => {
	if (metricValue.includes('m')) {
		return Math.round(parseInt(metricValue) / 10) / 100;
	} else if (metricValue.includes('n')) {
		return Math.round(parseInt(metricValue) / 10000000) / 100;
	} else if (metricValue.includes('Gi')) {
		return parseInt(metricValue) * 1024;
	} else if (metricValue.includes('Mi')) {
		return parseInt(metricValue);
	} else if (metricValue.includes('Ki')) {
		return Math.round((parseInt(metricValue) / 1024) * 100) / 100;
	} else {
		return parseInt(metricValue);
	}
};

var unitMap = {
    memory: 'Mi',
    cpu: ' vCPU'
}

module.exports = () => new PodMetrics().start();
