'use strict';

//  echo "hello world" 2>&1 | dogcat 127.0.0.1 8124 -d -o "#provision,hostname:"$HOSTNAME-sgp1-01 -

let fs = require('fs');

if (process.env.LOGPUTD_CONFIG) {
	if (!fs.existsSync(process.env.LOGPUTD_CONFIG)) {
		console.error("Config file does not exist: " + process.env.LOGPUTD_CONFIG + ", using default");
		delete process.env.LOGPUTD_CONFIG;
	}
}

if (process.env.LOGPUTD_STORAGE) {
	if (!fs.existsSync(process.env.LOGPUTD_STORAGE)) {
		console.error("Storage file does not exist: " + process.env.LOGPUTD_STORAGE);
		delete process.env.LOGPUTD_STORAGE;
	}
}

let config = require(process.env.LOGPUTD_CONFIG || './config');
let storage;
try {
	storage = require(process.env.LOGPUTD_STORAGE || './storage');
} catch (err) {
	console.error("Storage not configured: " + err);
}

let dgram = require('dgram');

let mkdirp = require('mkdirp');
let cron = require('node-cron');
let s3 = require('s3');
let dir = require('node-dir');
let async = require('async');
var dateFormat = require('dateformat');

let logFiles = { };
let s3Client;

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
					let filePath = config.LogDirectory
						+ '/' + fileName;
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
						logFile.stream.write('\r\n');
					}
					break;
				}
			}
		}
	}
});

dogcatUdpSocket.bind(process.env.LOGPUTD_DOGCAT_PORT || config.dogcat.Port);

function rotateAll(callback) {
	let timePrefix = dateFormat(storage.TimePrefix);
	return dir.files(config.LogDirectory, function(err, files) {
		if (err) return callback && callback(err);
		return async.eachSeries(files, function(file, callback) {
			let fileBase = file.slice(config.LogDirectory.length + 1);
			let fileBaseNameIdx = fileBase.lastIndexOf('/');
			let fileBaseFolder = fileBase.slice(0, fileBaseNameIdx);
			let fileBaseName = fileBase.slice(fileBaseNameIdx + 1);
			let rotateFileFolder = config.RotateDirectory + '/' + fileBaseFolder;
			let rotateFileBase = config.RotateDirectory + '/' + fileBaseFolder + '/' + timePrefix + '_' + fileBaseName;
			let rotateFilePath = rotateFileBase + '.' + storage.FileExtension;
			let addIdx = 1;
			while (fs.existsSync(rotateFilePath)) {
				rotateFilePath = rotateFileBase + '_' + addIdx + '.' + storage.FileExtension;
				++addIdx;
			}
			return mkdirp(rotateFileFolder, function(err) {
				if (err) return callback && callback(err);
				let logFile = logFiles[fileBase];
				if (logFile) {
					delete logFiles[fileBase];
					console.log("Rotate " + file + " -> " + rotateFilePath);
					return fs.rename(file, rotateFilePath, function(err) {
						if (err) console.error("Error " + err);
						console.log("Close " + fileBase);
						return logFile.stream.end(function() {
							logFile.stream.destroy();
							return callback(err);
						});
					});
				}
				console.log("Rotate " + file + " -> " + rotateFilePath);
				return fs.rename(file, rotateFilePath, callback);
			});
		}, function(err) {
			return callback && callback(err);
		});
	});
}

function keyExists(storagePath, callback) {
	let params = {
		Bucket: storage.Bucket, 
		Key: storagePath
	};
	return s3Client.s3.headObject(params, function(err, data) {
		if (err) {
			if (err.statusCode == 404) {
				return callback && callback(null, false);
			}
			console.error("Error checking file: " + err);
			return callback && callback(err, false);
		}
		return callback && callback(null, !!data && !!data.ContentLength);
	});
}

function uploadAndDelete(filePath, storagePath, callback) {
	
	// TODO: Validate storagePath does not exist, and keep renaming otherwise until one is available
	
	keyExists(storagePath);
	
	let finalStoragePath = storagePath;
	let storagePathExtIdx = storagePath.lastIndexOf('.');
	let storagePathBase = storagePath.slice(0, storagePathExtIdx);
	let storagePathExt = storagePath.slice(storagePathExtIdx + 1);
	let storageIdx = 1;
	
	let continueUpload = function() {
		console.log("Store " + filePath + " -> " + finalStoragePath);
		
		let params = {
			localFile: filePath,
			s3Params: {
				Bucket: storage.Bucket,
				Key: finalStoragePath,
				ContentType: storage.ContentType
				// other options supported by putObject, except Body and ContentLength. 
				// See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property 
			},
		};
	
		let uploader = s3Client.uploadFile(params);
		uploader.on('error', function(err) {
			console.error("Unable to upload:", err.stack);
			return callback(err);
		});
		
		uploader.on('end', function() {
			fs.unlink(filePath);
			console.log("Store OK: " + finalStoragePath);
			return callback();
		});
	};
	
	let continueCheck = function() {
		return keyExists(finalStoragePath, function(err, exists) {
			if (err) return callback(err);
			if (exists) {
				console.log("Already exists: " + finalStoragePath);
				finalStoragePath = storagePathBase + '_' + storageIdx + '.' + storagePathExt;
				++storageIdx;
				return continueCheck();
			} else {
				return continueUpload();
			}
		});
	};
	
	return continueCheck();
}

function uploadAll(callback) {
	return dir.files(config.RotateDirectory, function(err, files) {
		if (err) return callback && callback(err);
		return async.eachSeries(files, function(file, callback) {
			let fileBase = file.slice(config.RotateDirectory.length + 1);
			let storageFile = storage.Directory + '/' + fileBase;
			return uploadAndDelete(file, storageFile, callback);
		}, function(err) {
			return callback && callback(err);
		});
	});
}

if (storage) {
	s3Client = s3.createClient({
		maxAsyncS3: 20,     // this is the default
		s3RetryCount: 3,    // this is the default
		s3RetryDelay: 1000, // this is the default
		multipartUploadThreshold: 20971520, // this is the default (20 MB)
		multipartUploadSize: 15728640, // this is the default (15 MB)
		s3Options: {
			accessKeyId: storage.Key,
			secretAccessKey: storage.SecretKey,
			endpoint: storage.Endpoint,
			// sslEnabled: false
			// any other options are passed to new AWS.S3()
			// See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Config.html#constructor-property
		},
	});
	
	uploadAll();
	cron.schedule(storage.Cron, function() {
		rotateAll(uploadAll);
	});
}
