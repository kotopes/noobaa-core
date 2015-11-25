import template from './node-info.html';
import ko from 'knockout';
import moment from 'moment';
import style from 'style';
import { formatSize } from 'utils';

class NodeInfoViewModel {
	constructor({ node }) {
		this.dataReady = ko.pureComputed(
			() => !!node()
		)

		this.version = ko.pureComputed(
			() => node().version
		);

		this.hostname = ko.pureComputed(
			() => node().os_info.hostname
		);

		this.upTime = ko.pureComputed(
			() => moment(node().os_info.uptime).fromNow(true)
		);
		
		this.osType = ko.pureComputed(
			() => node().os_info.ostype
		);

		this.cpus = ko.pureComputed(
			() => this._mapCpus(node())
		);

		this.memory = ko.pureComputed(
			() => formatSize(node().os_info.totalmem)
		);

		this.totalSize = ko.pureComputed(
			() => formatSize(node().storage.total)
		);

		this.networks = ko.pureComputed(
			() => this._mapNetwotkInterfaces(node().os_info.networkInterfaces)
		);

		this.drives = ko.pureComputed(
			() => this._mapDrives(node().drives)
		);
	}

	_mapCpus({ os_info }) {
		return `${os_info.cpus.length}x ${os_info.cpus[0].model}`;
	}

	_mapNetwotkInterfaces(networkInterfaces) {
		return Object.keys(networkInterfaces).map( controller => {
			return { 
				controller: controller, 
				interfaces: networkInterfaces[controller].map( addr => addr.address )
			};
		});
	}

	_mapDrives(drives) {
		return drives.map( ({ mount, storage }) => {
			let { total, used = 0, free} = storage;
			let os = total - (used + free);

			return {
				name: mount,
				values: [
					{ value: used, label: formatSize(used),	color: style['text-color6'] },
					{ value: os,   label: formatSize(os),	color: style['text-color2'] },
					{ value: free, label: formatSize(free),	color: style['text-color5'] }
				]
			};
		});
	}
}

export default {
	viewModel: NodeInfoViewModel,
	template: template
}