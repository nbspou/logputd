'use strict';

//  echo "hello world" 2>&1 | dogcat 127.0.0.1 8124 -d -o "#provision,hostname:"$HOSTNAME-sgp1-01 -

let fs = require('fs');
let mkdirp = require('mkdirp');
let config = require('./config');

let dgram = require('dgram');

let logFiles = { };

let dogcatUdpSocket = dgram.createSocket('udp4');

let dogcatTagMap = {
	d: 'timestamp',
	h: 'hostname',
	t: 'alert_type'
};

dogcatUdpSocket.on('listening', function () {
	let address = dogcatUdpSocket.address();
	console.log('UDP Server listening on ' + address.address + ":" + address.port);
});

String.prototype.replaceAt = function(index, replacement) {
    return this.substr(0, index) + replacement + this.substr(index + replacement.length);
};

dogcatUdpSocket.on('message', function(msg, rinfo) {
	let messages = msg.toString().split('\n');
	let i;
	let str;
	for (i = 0; i < messages.length; ++i) {
		str = messages[i];
		if (str.startsWith("_e{")) {
			let titleLenIdx = 3;
			let titleLenLen = str.indexOf(',', titleLenIdx) - titleLenIdx;
			let textLenIdx = titleLenIdx + titleLenLen + 1;
			let textLenLen = str.indexOf('}', textLenIdx) - textLenIdx;
			let titleLen = parseInt(str.slice(titleLenIdx, titleLenIdx + titleLenLen), 10);
			let textLen = parseInt(str.slice(textLenIdx, textLenIdx + textLenLen), 10);
			let titleIdx = str.indexOf(':', textLenIdx + textLenLen) + 1;
			let title = str.slice(titleIdx, titleIdx + titleLen);
			let textIdx = str.indexOf('|', titleIdx + titleLen) + 1;
			let text = str.slice(textIdx, textIdx + textLen);
			let remainingIdx = str.indexOf('|', textIdx + textLen) + 1;
			let remaining = (remainingIdx > 0) ? (str.slice(remainingIdx).split('|')) : ([ ]);
			let tags = { };
			tags.address = rinfo.address;
			if (title.length) {
				tags.title = title;
			}
			if (text.length) {
				tags.text = text;
			}
			let j;
			for (j = 0; j < remaining.length; ++j) {
				let r = remaining[j];
				if (r.startsWith('#')) {
					let tagList = r.slice(1).split(',');
					let k;
					for (k = 0; k < tagList.length; ++k) {
						let tag = tagList[k].split(':', 2);
						tags[tag[0]] = tag[1] || tag[0];
					}
				} else {
					let idx = r.indexOf(':');
					if (idx > 0 && idx < r.length - 1) {
						let t = r.slice(0, idx);
						let tag = dogcatTagMap[t];
						if (tag) {
							let v = r.slice(idx + 1);
							tags[tag] = v;
						}
					}
				}
			}
			for (let tag in tags) {
				let cfg = config.dogcat[tag];
				if (cfg) {
					let fileName = cfg.FileName;
					for (let tag in tags) {
						fileName = fileName.replace('$' + tag, tags[tag]);
					}
					if (cfg.FileDirectorySplit) {
						let s = cfg.FileDirectorySplit;
						let k;
						let nb = 0;
						for (k = 0; k < fileName.length; ++k) {
							if (fileName[k] == s) {
								fileName = fileName.replaceAt(k, '/');
								++nb;
								if (nb >= cfg.FileDirectoryDepth) {
									break;
								}
							}
						}
					}
					let format = cfg.Format;
					for (let tag in tags) {
						format = format.replace('$' + tag, tags[tag]);
					}
					fileName = (cfg.Directory ? (cfg.Directory + '/') : '') + fileName;
					let filePath = config.LogDirectory 
						+ '/' + cfg.Directory
						+ '/' + fileName + '.' + cfg.FileExtension;
					let logFile = logFiles[fileName];
					if (!logFile) {
						logFile = {
							fileName: fileName,
							filePath: filePath,
							cfg: cfg
						};
						let parentDir = filePath.slice(0, filePath.lastIndexOf('/'));
						mkdirp.sync(parentDir);
						logFile.stream = fs.createWriteStream(filePath, { flags: 'a' });
						logFiles[fileName] = logFile;
					}
					if (logFile) {
						logFile.stream.write(text);
						logFile.stream.write('\n');
					}
					break;
				}
			}
		}
	}
});

dogcatUdpSocket.bind(config.dogcat.Port);
