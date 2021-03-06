// ===============================================================================
// UTILITY FUNCTIONS
// ===============================================================================
const Q = require('q');
const path = require('path');
const fs = require('fs');

var nodemailer = require('nodemailer');
var smtpTransport = require('nodemailer-smtp-transport');
const nodemailerSendgrid = require('nodemailer-sendgrid');
var mailTransport;

const crypto = require('crypto');
const mkdirp = require('mkdirp');

var UtilitiesExtension = require('./utilities_ext.js');
var async = require('async');

var dataAccess;
var settings;

var eventLog;
var errorLog;
var sessionLog;

var Utilities = function (s) {
	settings = s;
	this.extension = {};
  
  let mailAuth = {};
  let mo = settings.data.mail_options;
  if(mo) {
    if(mo.user) mailAuth.user = mo.user;
    if(mo.pass) mailAuth.pass = mo.pass;
    if(mo.api_key) mailAuth.api_key = mo.api_key;
  
    var options = {};

    if (mo.service){

      // SEND GRID WANTS ONLY THE API KEY IN THE AUTH FIELD IF AVAILABLE
      if(mo.service.toLowerCase() === 'sendgrid' && mailAuth.api_key) {if([])
        mailTransport = nodemailer.createTransport(nodemailerSendgrid({apiKey:mailAuth.api_key}));
      }
      else {
        options = {
          service: mo.service,
          auth: mailAuth
        }
        if(mo.port) options.port = mo.port;
        if(mo.tls) options.tls = mo.tls

        mailTransport = nodemailer.createTransport(smtpTransport(options));
      }
    }
    else {
      options = {
        host: mo.host,
        port: mo.port,
        auth: mailAuth
      }
      if(mo.tls) options.tls = mo.tls;      

      mailTransport = nodemailer.createTransport(smtpTransport(options));
    } 
  }
};

Utilities.prototype.getHash = (alg, data, length) => {
  var deferred = Q.defer();

  if(alg == null) alg = 'sha256';
  var h = crypto.createHash(alg);

  let byteCount = length || 10;
  if(data == null) data = crypto.randomBytes(byteCount);
  h.update(data);

  var digest = h.digest('hex');
  if(length != null) digest = digest.substring(0, length);
  deferred.resolve(digest);

  return deferred.promise;
}

Utilities.prototype.getDataAccess = function(){
	return dataAccess;
}

Utilities.prototype.setDataAccess = function(da){
	dataAccess = da;
	if(this.extension !== undefined && this.extension !== null) {
		this.extension = new UtilitiesExtension(this, da, settings);
	}
};

Utilities.prototype.setLogs = function(evl, erl, sesl) {
  eventLog = evl;
  errorLog = erl;
  sessionLog = sesl;
}

Utilities.prototype.validateUsername = function (newUsername, existingUsername) {
	var deferred = Q.defer();

	if (newUsername === existingUsername) {
		deferred.resolve();
	}
	else {
		dataAccess.getUserByUserName(newUsername)
			.then(function (userFound) {
				var errorObj = new ErrorObj(400,
					'u0053',
					__filename,
					'bsuser',
					'a user already exists with the username provided'
				);
				deferred.reject(errorObj);
			})
			.fail(function (err) {
				deferred.resolve();
			});
	}

	return deferred.promise;
}

Utilities.prototype.validateEmail = function (newEmail, existingEmail) {
	var deferred = Q.defer();

	if (newEmail === existingEmail) {
		deferred.resolve();
	}
	else {
		dataAccess.getUserByEmail(newEmail)
			.then(function (userFound) {
				var errorObj = new ErrorObj(400,
					'u0054',
					__filename,
					'bsuser',
					'a bsuser already exists with the email provided'
				);

				deferred.reject(errorObj);
			})
			.fail(function (err) {

				if (err.err_code == 'da2001') {
					// THERE WERE MULTIPLE ACCOUNTS FOUND WITH THIS EMAIL
					// IN A PREVIOUS VERSION OF BS ACCOUNTS WERE ABLE TO SHARE EMAILS
					var errorObj = new ErrorObj(400,
						'u0055',
						__filename,
						'bsuser',
						'a bsuser already exists with the email provided',
						err
					);

					deferred.reject(errorObj);
				}
				else {
					deferred.resolve();
				}
			});
	}

	return deferred.promise;
}

Utilities.prototype.getUserFromApiToken = function (apiTkn, callback) {
	var deferred = Q.defer();
	dataAccess.findOne('session', { 'object_type': 'session', 'token': apiTkn })
		.then(function (sessionObj) {
			if(sessionObj.is_anonymous) {
				return {'object_type': 'bsuser', 'username': 'anonymous'};
			}
			else {
				return dataAccess.findOne('bsuser', { 'object_type': 'bsuser', 'username': sessionObj.username });
			}
		})
		.then(function (userObj) {
			deferred.resolve(userObj);
		})
		.fail(function (err) {
			// ADD LOGGING HERE?
			if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
				deferred.reject(err.AddToError(__filename, 'getUserFromApiToken'));
			}
			else {
				var errorObj = new ErrorObj(500,
					'u1001',
					__filename,
					'getUserFromApiToken',
					'error getting user from api token',
					'Error getting user from api token',
					err
				);
				deferred.reject(errorObj);
			}
		});

	deferred.promise.nodeify(callback);
	return deferred.promise;
};


Utilities.prototype.FormatStackTraceMessage = function (verb, objType, versionExtension) {
	return { 'class': objType + versionExtension, 'function': verb + ' ' + objType };
};

Utilities.prototype.GetUrlForS3 = function (obj, callback) {
	var deferred = Q.defer();

	var params = { Bucket: obj.resources.s3.bucket, Key: obj.resources.s3.name };
	obj.resources.s3.getSignedUrl('getObject', params, function (s3_err, s3_res) {
		if (!s3_err) {
			deferred.resolve(s3_res);
		}
		else {
			var errorObj = new ErrorObj(500,
				'u0001',
				__filename,
				'GetUrlForS3',
				'error getting url from s3',
				'S3 error',
				s3_err
			);
			deferred.reject(errorObj);
		}
	});

	deferred.promise.nodeify(callback);
	return deferred.promise;
};

Utilities.prototype.GetValidationModel = function(){
	return {
		'success': false,
		Message: '',
		ValidatedObject: null
	};
};

Utilities.prototype.CreateErrorObject = function(httpStatus, className, httpVerb, model,
errorMessage, errorCode, addtnlResults){
	var errObj =
	 {
		'http_status': httpStatus,
		'stack_trace': [{'class': className, 'function': httpVerb + ' ' + model}],
		'message': errorMessage,
		'err_code': errorCode,
		'results': addtnlResults
	};
	return errObj;
};

Utilities.prototype.requestHasHeaders = function (req) {
	return req.headers[settings.data.token_header] !== undefined && req.headers[settings.data.token_header] !== null;
};

Utilities.prototype.isNullOrUndefinedOrZeroLength = function (meVar) {
	return meVar == null || meVar.length === 0;
};


Utilities.prototype.StringIsNullOrEmpty = function(stringValue){
	return stringValue === null || stringValue === '';
};

//directory name contains version and file contains model and class
Utilities.prototype.ClassAndModelInfo = function(directoryName, fileName) {
	var className = path.basename(fileName);
	var toRemove = directoryName.substring(0,  directoryName.indexOf('Helpers') + 9);
    var version = directoryName.replace(toRemove, '');
	version = version.replace('_', '.');
	version = version.replace('_', '.');
	return {
		Class: className,
		Model: className.replace('.js', '') + ' ' + version,
		Version: version
	};
};

Utilities.prototype.copyFile = function(file_to_copy, destination_path){
	var deferred = Q.defer();
	try {
		fs.createReadStream(file_to_copy).pipe(fs.createWriteStream(destination_path));
		deferred.resolve({ 'success': true });
	}
	catch (err) {
		var errorObj = new ErrorObj(500,
			'u0002',
			__filename,
			'copyFile',
			'error with fs.createReadStream',
			'External error',
			err
		);
		deferred.reject(errorObj);
	}
	return deferred.promise;
};

function getFileStream(file_to_copy) {
	var deferred = Q.defer();
	var getFs = fs.createReadStream(file_to_copy);
	getFs.on("error", function (err) {
		var errorObj = new ErrorObj(500,
			'u0003',
			__filename,
			'getFileStream',
			'error with fs.createReadStream',
			'External error',
			err
		);
		deferred.reject(errorObj);
	});
	getFs.on("open", function (err) {
		deferred.resolve(getFs);
	});
	return deferred.promise;
};

function getWriteFileStream(destination_path) {
	var deferred = Q.defer();
	var writeFs = fs.createWriteStream(destination_path);
	writeFs.on("error", function (err) {
		var errorObj = new ErrorObj(500,
			'u0004',
			__filename,
			'getWriteFileStream',
			'error with fs.createWriteStream',
			'External error',
			err
		);
		deferred.reject(errorObj);
	});
	writeFs.on("open", function (ex) {
		deferred.resolve(writeFs);
	});
	return deferred.promise;
};

Utilities.prototype.writeToFile = function (file_path, strData) {
	var deferred = Q.defer();

	fs.writeFile(file_path, strData,
		function (write_err) {
			if (write_err) {
				var errorObj = new ErrorObj(500,
					'u0005',
					__filename,
					'writeToFile',
					'error with fs.writeToFile',
					'External error',
					write_err
				);
				deferred.reject(errorObj);
			}
			else {
				deferred.resolve(true);
			}
		}
	);

	return deferred.promise;
};

Utilities.prototype.writeBinaryToFile = function (file_path, strData) {
	var deferred = Q.defer();

	mkdirp(path.dirname(file_path), function (err) {
		if (!err) {
			fs.writeFile(file_path, strData, 'binary',
				function (write_err) {
					if (write_err) {
						var errorObj = new ErrorObj(500,
							'u0006',
							__filename,
							'writeBinaryToFile',
							'error with fs.writeToFile',
							'External error',
							write_err
						);
						deferred.reject(errorObj);
					}
					else {
						deferred.resolve(true);
					}
				}
			);
		}
		else {
			var errorObj = new ErrorObj(500,
				'u0007',
				__filename,
				'writeToFile',
				'error with mkdirp',
				'External error',
				err
			);
			deferred.reject(errorObj);
		}
	});

	return deferred.promise;
};

Utilities.prototype.writeErrorToLog = function (errObj) {
  var deferred = Q.defer();

  let logEntry = JSON.stringify(errObj)+'\n';

  var writeToLog = Q.denodeify(errorLog.write);
  writeToLog(logEntry)
  .then(function(write_res) {
    deferred.resolve();
  })
  .fail(function(write_err) {
    deferred.reject(write_err);
  });

	return deferred.promise;
};

Utilities.prototype.sendMail = function (send_to, sbj, bdy, html_bdy, attachments, replyTo, inReplyTo, from, callback) {
	var deferred = Q.defer();

	var mailOptions = {
		from: from || settings.data.mail_options.account,
		to: send_to,
		subject: sbj
	};
  if(html_bdy) {
    mailOptions.html = html_bdy;
  }
  if(bdy) {
    mailOptions.text = bdy;
  }
  if(html_bdy == null && bdy == null) {
    deferred.reject(new ErrorObj(500,
                                  'u0100',
                                  __filename,
                                  'sendMail',
                                  'no content',
                                  'Attempt to send empty email.'));
    return deferred.promise.nodeify(callback);
  }

  if (replyTo) {
    mailOptions.replyTo = replyTo;
  }

  if (inReplyTo) {
    mailOptions.inReplyTo = inReplyTo;
  }

  if(attachments) {
    if(Array.isArray(attachments)) {
      mailOptions.attachments = attachments;
    }
    else if(typeof(attachments) === 'object') {
      mailOptions.attachments = [attachments];
    }
  }
	mailTransport.sendMail(mailOptions, function (email_err, email_res) {
		if (!email_err) {
			deferred.resolve(email_res);
		}
		else {
			var errorObj = new ErrorObj(500,
				'u0009',
				__filename,
				'sendMail',
				'error with mailTransport.sendMail',
				'External error',
				email_err
			);
			deferred.reject(errorObj);
		}
	});

	deferred.promise.nodeify(callback);
	return deferred.promise
};

Utilities.prototype.sendMailTemplate = function (send_to, sbj, template_name, args, attachments, callback) {
	var deferred = Q.defer();

	if (template_name === undefined || template_name === null) {
		template_name = 'default';
	}

	if (args === undefined || args === null) {
		args = {};
	}

	var templatePath = path.resolve(__dirname, settings.data.mail_options.template_directory + template_name);
	var txtPath = templatePath + '.txt';
	var htmlPath = templatePath + '.html';

	var foundTxt = true;
	var foundHtml = true;
	try {
		fs.accessSync(txtPath);
	}
	catch (e) {
		foundTxt = false;
	}

	try {
		fs.accessSync(htmlPath);
	}
	catch (e) {
		foundHtml = false;
	}

	var txtBody = '';
	var htmlBody = '';

	if (foundTxt && foundHtml) {
		fs.readFile(txtPath, 'utf8', function (txt_err, txt_data) {
			if (!txt_err) {
				txtBody = replaceTemplateValues(txt_data, args)
				fs.readFile(htmlPath, 'utf8', function (html_err, html_data) {
					if (!html_err) {
						htmlBody = replaceTemplateValues(html_data, args);

						var mailOptions = {
							from: settings.data.mail_options.account,
							to: send_to,
							subject: sbj,
							text: txtBody,
							html: htmlBody
						};
            if(attachments) {
              if(Array.isArray(attachments)) {
                mailOptions.attachments = attachments;
              }
              else if(typeof(attachments) === 'object') {
                mailOptions.attachments = [attachments];
              }
            }
						mailTransport.sendMail(mailOptions, function (email_err, email_res) {
							if (!email_err) {
								deferred.resolve(email_res);
							}
							else {
								var errorObj = new ErrorObj(500,
									'u0011',
									__filename,
									'sendMailTemplate',
									'error with mailTransport.sendMail',
									'External error',
									email_err
								);
								deferred.reject(errorObj);
							}
						});
					}
					else {
						// SOMETHING WENT WRONG WHILE READING THE HTML TEMPLATE
						var errorObj = new ErrorObj(500,
							'u0012',
							__filename,
							'sendMailTemplate',
							'error reading html template',
							'There was a problem getting the html template for this email',
							html_err
						);
						deferred.reject(errorObj);
					}
				});
			}
			else {
				// SOMETHING WENT WRONG WHILE READING THE TXT TEMPLATE
				var errorObj = new ErrorObj(500,
					'u0013',
					__filename,
					'sendMailTemplate',
					'error reading text template',
					'There was a problem getting the text template for this email',
					txt_err
				);
				deferred.reject(errorObj);
			}
		});
	}
	else if (foundTxt) {
		fs.readFile(txtPath, 'utf8', function (txt_err, txt_data) {
			if (!txt_err) {
				txtBody = replaceTemplateValues(txt_data, args);
				var mailOptions = {
					from: settings.data.mail_options.account,
					to: send_to,
					subject: sbj,
					text: txtBody
				};
        if(attachments) {
          if(Array.isArray(attachments)) {
            mailOptions.attachments = attachments;
          }
          else if(typeof(attachments) === 'object') {
            mailOptions.attachments = [attachments];
          }
        }
				mailTransport.sendMail(mailOptions, function (email_err, email_res) {
					if (!email_err) {
						deferred.resolve(email_res);
					}
					else {
						var errorObj = new ErrorObj(500,
							'u0014',
							__filename,
							'sendMailTemplate',
							'error with mailTransport.sendMail',
							'External error',
							email_err
						);
						deferred.reject(errorObj);
					}
				});
			}
			else {
				// SOMETHING WENT WRONG WHILE READING THE TXT TEMPLATE
				var errorObj = new ErrorObj(500,
					'u0015',
					__filename,
					'sendMailTemplate',
					'error reading text template',
					'There was a problem getting the text template for this email',
					txt_err
				);
				deferred.reject(errorObj);
			}
		});
	}
	else if (foundHtml) {
		fs.readFile(htmlPath, 'utf8', function (html_err, html_data) {
			if (!html_err) {
				htmlBody = replaceTemplateValues(html_data, args);
				var mailOptions = {
					from: settings.data.mail_options.account,
					to: send_to,
					subject: sbj,
					html: htmlBody
				};
        if(attachments) {
          if(Array.isArray(attachments)) {
            mailOptions.attachments = attachments;
          }
          else if(typeof(attachments) === 'object') {
            mailOptions.attachments = [attachments];
          }
        }
				mailTransport.sendMail(mailOptions, function (email_err, email_res) {
					if (!email_err) {
						deferred.resolve(email_res);
					}
					else {
						var errorObj = new ErrorObj(500,
							'u0016',
							__filename,
							'sendMailTemplate',
							'error with mailTransport.sendMail',
							'External error',
							email_err
						);
						deferred.reject(errorObj);
					}
				});
			}
			else {
				// SOMETHING WENT WRONG WHILE READING THE HTML TEMPLATE
				var errorObj = new ErrorObj(500,
					'u0017',
					__filename,
					'sendMailTemplate',
					'error reading html template',
					'There was a problem getting the html template for this email',
					html_err
				);
				deferred.reject(errorObj);
			}
		});
	}
	else {
		// WE COULDN'T FIND THIS TEMPLATE.
    var errorObj = new ErrorObj(500,
      'u0021',
      __filename,
      'sendMailTemplate',
      'no template found',
      'There is no email template by this name',
      null
    );
    deferred.reject(errorObj);
	}

	deferred.promise.nodeify(callback);
	return deferred.promise
};

function replaceTemplateValues(template, args) {
	var updatedTemplate = template;
	for(var key in args){
    updatedTemplate = updatedTemplate.replace(new RegExp('{{' + key + '}}', 'g'), args[key]);
  }

	return updatedTemplate;
}

Utilities.prototype.getUID = function (callback) {
	var deferred = Q.defer();

	var tKey = crypto.randomBytes(12).toString('hex');
	var date = new Date();
	var dateKey = new Date(date.getFullYear(), date.getMonth(), date.getDay(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
	var token = crypto.createHash("md5").update(tKey + dateKey).digest('hex');
	deferred.resolve(token);

	return deferred.promise;
};

Utilities.prototype.logEvent = function(tkn, eventDescriptor) {
	var deferred = Q.defer();

	var loggedEvent = {
		'token': tkn,
		'event_data': eventDescriptor
  };
  let logEntry = JSON.stringify(loggedEvent)+'\n';
  eventLog.write(logEntry, () => {
    deferred.resolve();
  });

	return deferred.promise;
}

Utilities.prototype.invalidateSession = function(sessionObj) {
  var deferred = Q.defer();

  dataAccess.hardDeleteEntity('session', sessionObj)
  .then(() => {
    if(settings.data.session_logging === true) {
      let dsObj = {
        session_id: sessionObj.id,
        token: sessionObj.token,
        user_id: sessionObj.user_id,
        started_at: sessionObj.started_at,
        ended_at: new Date()
      }
      var logEntry = JSON.stringify(dsObj)+'\n';
      sessionLog.write(logEntry);
    }

    deferred.resolve();
  })
  .fail((err) => {
    deferred.reject(err.AddToError(__filename, 'invalidateSession'));
  });

  return deferred.promise;
}

Utilities.prototype.isNullOrUndefined = function(value){
	return value === null || typeof(value) === 'undefined' || value === undefined;
};


Utilities.prototype.htmlify = function(obj, idx) {
	if(idx === undefined || idx === null || typeof(idx) !== 'number') {
		idx = 0;
	}

	var pList = Object.getOwnPropertyNames(obj);
	var indentString = '';
	for(var iIdx = 0; iIdx < idx; iIdx++) {
		indentString += '&nbsp;&nbsp;&nbsp;&nbsp;';
	}

	var newHtmlString = '';
	for(var pIdx = 0; pIdx < pList.length; pIdx++) {
		var propName = pList[pIdx];
		if(typeof(obj[propName]) !== 'object') {
				newHtmlString += indentString + propName + ': ' + obj[propName] + '<br />';
		}
		else if(obj[propName] !== undefined && obj[propName] !== null) {
			newHtmlString += indentString + propName + ':<br />';
			var nextIdx = idx+1;
			newHtmlString += Utilities.prototype.htmlify(obj[propName], nextIdx);
		}
		else {
			newHtmlString += indentString + propName + ':  null' + '<br />';
		}
	}

	if(idx === 0) {
		newHtmlString = '<div>' + newHtmlString + '</div>';
	}

	return newHtmlString;
}

exports.Utilities = Utilities;
