/*jshint expr: true, es5: true, unused:false */

// ==================================================================================
// SETUP
// ==================================================================================
// ---------------------------------
// IMPORT MODULES
// ---------------------------------
var http = require('http');		// We'll create our server with the http module
var express = require('express');	// Import express to handle routing and server details
var cors = require('cors');		// Setup CORS
var path = require('path');			// Import path to control our folder structure
var bodyParser = require('body-parser');
var Q = require('q');
var fs = require('fs');
var async = require('async');
const rootDir = path.dirname(require.main.filename);
const multer = require('multer');
const upload = multer();

require('./ErrorObj');

var Settings = require('./settings').Settings;
var Endpoints = require('./endpoints').Endpoints;
var DataAccess = require('./dataAccess').DataAccess;
var ServiceRegistration = require('./serviceRegistration').ServiceRegistration;
var Controller = require('./controller').Controller;		// GETS THE CORRECT WEB SERVICE FILE AND ROUTES CALLS
var Utilities = require('./utilities').Utilities;
var AccessControl = require('./accessControl').AccessControl;
var Models = require('./models.js').Models;
var schemaControl = require('./schema.js');
var expressSettings;

// ---------------------------------
// SETUP EXPRESS
// ---------------------------------
var app = express();
app.set('views', path.join(__dirname, 'views'));	// MAP views TO FOLDER STRUCTURE
app.set('view engine', 'jade');						// USE JADE FOR TEMPLATING

const requestSizeLimit = (process.env.MAX_REQUEST_SIZE && !isNaN(process.env.MAX_REQUEST_SIZE) && Number(process.env.MAX_REQUEST_SIZE > 0)) ? process.env.MAX_REQUEST_SIZE+'mb' : '50mb';
app.use(bodyParser.json({ limit: requestSizeLimit }));		// THIS IS A HIGH DEFAULT LIMIT SINCE BACKSTRAP ALLOWS BASE64 ENCODED FILE UPLOAD
app.use(bodyParser.urlencoded({ extended: true }));			// DETERMINE IF THIS IS HTML OR JSON REQUEST
app.use(express.static(path.join(__dirname, 'public')));	// MAP STATIC PAGE CALLS TO public FOLDER
// UPLOAD FILES AS form-data IN A FIELD CALLED "mpfd_files"
app.use(upload.array("mpfd_files", 10));
app.use(cors());


// PASS THE HANDLE TO THE EXPRESS APP INTO
// express_init.js SO THE USER CAN ADD EXPRESS MODULES
try {
  expressSettings = require(`${rootDir}/expressSettings`);
}
catch(esErr) {
  console.warn('ExpressSettings could not be created.')
  console.warn(esErr);
}
try {
  expressSettings.init(app);
}
catch(expressInitErr) {
  console.error('ExpressSettings initialization failed');
  console.error(expressInitErr);
}


if(process.env.DEBUG_MODE != null && (process.env.DEBUG_MODE === true || process.env.DEBUG_MODE.toString().toLowerCase() === 'true')) {
  process.on('warning', e => console.warn(e.stack));       // USEFUL IN DEBUGGING
  process.on('unhandledRejection', r => console.log(r));   // USEFUL IN DEBUGGING
}


//Settings File, contains DB params
var nodeEnv = process.env.NODE_ENV || 'local';
var configFile = './config/config.' + nodeEnv + '.js';
var config = require(configFile);

var rsString = process.env.BS_REMOTE || 'false';
rsString = rsString.toLowerCase();
var useRemoteSettings = rsString == 'true' ? true : false;

var connectionString =
	'postgres://' + config.db.user + ':' + config.db.pass + '@' + config.db.host + ':' + config.db.port + '/' + config.db.name;  // DATABASE

console.log('==================================================');
console.log('INITIALIZATION');
console.log('==================================================');

var models;
var endpoints;
var dataAccess;
var serviceRegistration;
var utilities;
var accessControl;
var mainController;

var errorLog;
var sessionLog;
var accessLog;
var eventLog;

var settings = new Settings();
settings.init(config.s3.bucket, 'Settings.json', useRemoteSettings)
	.then(function (settings_res) {
		console.log('Settings initialized');
		utilities = new Utilities(settings);
		console.log('Utilities initialized');
		models = new Models(settings);
		return models.init(config.s3.bucket, 'Models.json', useRemoteSettings);
	})
	.then(function (endpoints_res) {
		console.log('Models initialized');
		endpoints = new Endpoints(settings);
		return endpoints.init(config.s3.bucket, 'Endpoints.json', useRemoteSettings);
	})
	.then(function (model_res) {
		console.log('Endpoints initialized');

		dataAccess = new DataAccess(config, models.data.models, utilities, settings);
		console.log('DataAccess initialized');
		//NOW SET THE DATA ACCESS VAR IN UTILITIES
		utilities.setDataAccess(dataAccess);
		serviceRegistration = new ServiceRegistration(dataAccess, endpoints, models, utilities);
		console.log('ServiceRegistration initialized');
		accessControl = new AccessControl(utilities, settings, dataAccess);
		return accessControl.init(config.s3.bucket, 'Security.json', useRemoteSettings);
	})
	.then(function (acl_res) {
		console.log('AccessControl initialized');
		mainController = new Controller(dataAccess, utilities, accessControl, serviceRegistration, settings, models, endpoints.data);
		console.log('Controller initialized');
		// GENERATE ENDPOINTS FROM MODELS
		return endpoints.generateFromModels(models.data.models, false);
	})
	.then(function (ge_res) {
		console.log('Models generated');
		// CREATE ANY NEW DB TABLES BASED ON MODELS
    let dbInfo = {
      name: config.db.name,
      user: config.db.user,
      pass: config.db.pass,
      host: config.db.host,
      port: config.db.port
    };
    if(Array.isArray(config.db)) {
      dbInfo = {
        name: config.db[0].name,
        user: config.db[0].user,
        pass: config.db[0].pass,
        host: config.db[0].host,
        port: config.db[0].port
      }
    }
    return schemaControl.updateSchema(models, dbInfo.name, dbInfo.user, dbInfo.pass, dbInfo.host, dbInfo.port, utilities);
  })
	.then(function (us_Res) {
    console.log('Schema updated');
    
    // CREATE A LOG DIRECTORY IF NEEDED
    // DO IT SYNCHRONOUSLY WHICH IS ALRIGHT SINCE THIS IS JUST ONCE
    // DURING STARTUP
    if(!fs.existsSync('./logs')) fs.mkdirSync('./logs');
    
    changeErrorLogs();
    utilities.setLogs(eventLog, errorLog, sessionLog);
    console.log('Log files opened');

		// SERVER PORT
		app.set('port', process.env.PORT || settings.data.server_port);

		// STARTUP THE SESSION INVALIDATION -- CHECK EVERY X MINUTES
		var timeoutInMintues = settings.data.timeout;
    var invalidSessionTimer = setInterval(function () { checkForInvalidSessions(dataAccess, settings) }, settings.data.timeout_check * 60000);
    
    // EVERYTHING IS INITIALIZED.  RUN ANY INITIALIZATION CODE
    try {
      require(`${rootDir}/onInit`).run(dataAccess, utilities, accessControl, serviceRegistration, settings);
    }
    catch(onInitErr) {
      if(onInitErr && onInitErr.code === 'MODULE_NOT_FOUND') {
        console.log('Initialization script skipped -- no file found');
      }
      else {
        console.error(onInitErr);
      }
    }
    
		// ========================================================
		// SETUP ROUTE HANDLERS
		// ========================================================
    // ---------------------------------------------------------------------------------
    // OVERRIDES
    // ---------------------------------------------------------------------------------
    if(expressSettings) {
      try {
        expressSettings.overrideRoutes(app, dataAccess, utilities);
      }
      catch(err) {
        console.error('Override Routes Failed');
        console.error(err);
      }
    }
		// ---------------------------------------------------------------------------------
		// GETS
		// ---------------------------------------------------------------------------------
		app.get('/:area/:controller/:serviceCall/:version?', function (req, res) {
			requestPipeline(req, res, 'GET');
    });
    app.get('/:area/:controller?', function (req, res) {
			requestPipeline(req, res, 'GET');
		});
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------

		// ---------------------------------------------------------------------------------
		// POSTS
		// ---------------------------------------------------------------------------------
		app.post('/:area/:controller/:serviceCall/:version?', function (req, res) {
			requestPipeline(req, res, 'POST');
    });
    app.post('/:area/:controller?', function (req, res) {
			requestPipeline(req, res, 'POST');
		});
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------
		// PUTS
		// ---------------------------------------------------------------------------------
		app.put('/:area/:controller/:serviceCall/:version?', function (req, res) {
			requestPipeline(req, res, 'PUT');
    });
    app.put('/:area/:controller?', function (req, res) {
			requestPipeline(req, res, 'PUT');
		});
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------
		// PATCH
		// ---------------------------------------------------------------------------------
		app.patch('/:area/:controller/:serviceCall/:version?', function (req, res) {
			requestPipeline(req, res, 'PATCH');
    });
    app.patch('/:area/:controller?', function (req, res) {
			requestPipeline(req, res, 'PATCH');
		});
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------
		// DELETES
		// ---------------------------------------------------------------------------------
		app.delete('/:area/:controller/:serviceCall/:version?', function (req, res) {
			requestPipeline(req, res, 'DELETE');
    });
    app.delete('/:area/:controller?', function (req, res) {
			requestPipeline(req, res, 'DELETE');
		});
		// ---------------------------------------------------------------------------------
		// ---------------------------------------------------------------------------------

		app.get('*', function (req, res) {
			res.status(404).send({ 'Error': 'Route/File Not Found' });
		});

		app.use(function (err, req, res, next) {
			if (req.xhr) {
				if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
					console.error('Bad JSON');
					res.status(400).send({ 'message': 'json body malformed' });
				}
				else {
					res.status(500).send({ 'message': 'unknown error' });
				}
			}
			else {
				next(err);
			}
		});

		// -----------------------------------
		// LAUNCH THE SERVER
		// -----------------------------------
		const server = http.createServer(app).listen(app.get('port'), function () {
			console.log('----------------------------------------------');
			console.log('----------------------------------------------');
			console.log('Express server listening on port ' + app.get('port'));
      console.log(`Started @ ${new Date().toISOString()}`);
			console.log('');

			if (useRemoteSettings) {
				settings.registerIp()
				.then(function (res) {
					console.log('Running in distributed mode');
				})
				.fail(function (err) {
					console.error('Problem registering ip');
				});
			}
    });
    
    if(settings.data.server_timeout != null) server.timeout = parseInt(settings.data.server_timeout);
    if(settings.data.keep_alive_timeout != null) server.keepAliveTimeout = parseInt(settings.data.keep_alive_timeout);
    if(settings.data.headers_timeout != null) server.headersTimeout = parseInt(settings.data.headers_timeout);
	})
	.fail(function (err) {
		console.log('Initialization Failure');
		console.log(err);
		return 2;
	});


// ================================================
// MAIN REQUEST PIPELINE
// ================================================
function requestPipeline(req, res, verb) {
  var params = req.params;
  var area = params.area;
  var controller = params.controller;
  var serviceCall
  if(!params.serviceCall) {
    if(settings.data.index_service_call != null) {
      serviceCall = settings.data.index_service_call;
    }
    else {
      serviceCall = "index";
    }
  }
  else{
    serviceCall = params.serviceCall;
  }
  
  var args;
  if(verb.toLowerCase() === 'get') {
    args = req.query;
  }
  else if(verb.toLowerCase() === 'delete') {
    // CHECK THE BODY FIRST, IF THERE IS NO BODY OR THE BODY IS EMPTY
    // CHECK THE QUERY STRING.
    args = req.body;
    if (utilities.isNullOrUndefinedOrZeroLength(args)) {
      args = {};
    }
    var argKeys = Object.keys(args);
    if (argKeys.length === 0) {
      args = req.query;
      req.body = req.query;
    }
  }
  else {
    args = req.body;
  }

  var version = params.version;

  var accessLogEvent;
  if(settings.data.access_logging === true) {
    var endpointString = area+'/'+controller+'/'+serviceCall+'/'+version;
    var ips = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    accessLogEvent = {
      start_timestamp: new Date().toISOString(),
      endpoint: endpointString,
      user_agent: req.headers['user-agent'],
      ips: ips
    };
  }

  serviceRegistration.serviceCallExists(serviceCall, area, controller, verb, version)
  .then(function (sc) {
    let continueWhenInvalid = false;
    if (!sc.authRequired) {
      continueWhenInvalid = true;
    }

    // IF THERE IS A BACKSTRAP STYLE AUTH HEADER OR NEITHER A BACKSTRAP AUTH HEADER NOR BASIC/BEARER AUTH HEADER 
    if(req.headers[settings.data.token_header] != null || 
        (req.headers[settings.data.token_header] == null && req.headers['authorization'] == null)) {
      return [sc, accessControl.validateToken(req.headers[settings.data.token_header], continueWhenInvalid)];
    }
    // OTHERWISE THIS IS BASIC OR BEARER AUTH
    // BASIC AUTH IS BACKSTRAP NATIVE API USERS
    // BEARER AUTH USES JWTs FROM EXTERNAL IDENTITY PROVIDERS
    else {
      [authType] = req.headers['authorization'].split(' ');
      if(authType.toLowerCase() === 'basic') {
        return [sc, accessControl.validateBasicAuth(req.headers['authorization'], continueWhenInvalid)];
      }
      else if(authType.toLowerCase() === 'bearer') {
        return [sc, accessControl.validateJwt(req.headers['authorization'], continueWhenInvalid)];
      }
      else {
        if(continueWhenInvalid) {
          return [sc, Q({is_valid: false})];
        }
        else {
          return [sc, Q.reject(new ErrorObj(403,
                                            'bs0001',
                                            __filename,
                                            'requestPipeline',
                                            'bad auth type',
                                            'Unauthorized',
                                           null))];
        }
      }
    }
  })
  .spread(function(sc, validTokenResponse) {
    var inner_deferred = Q.defer();
    
    if(validTokenResponse.is_valid === true) {

      // SEE IF THIS IS BACKSTRAP STYLE AUTH OR BASIC/BEARER AUTH
      if(validTokenResponse.hasOwnProperty('session')) {
        if(settings.data.access_logging === true) accessLogEvent.session_id = validTokenResponse.session.id;

        dataAccess.joinOne({object_type:'session', id:validTokenResponse.session.id}, 'bsuser')
        .then(function(usr) {
          inner_deferred.resolve(usr);
        })
        .fail(function(usr_err) {
          if(sc.authRequired) {
            var errorObj = new ErrorObj(403,
                                        'bs0002',
                                        __filename,
                                        'requestPipeline',
                                        'unauthorized',
                                        'Unauthorized',
                                        null);
            inner_deferred.reject(errorObj);
          }
          else {
            inner_deferred.resolve(null);
          }
        });
      }
      else if(validTokenResponse.hasOwnProperty('user')) {
        inner_deferred.resolve(validTokenResponse.user);
      }
      else {
        if(settings.data.access_logging === true) accessLogEvent.client_id = validTokenResponse.client_id;

        dataAccess.findOne('bsuser', {client_id: validTokenResponse.client_id})
        .then(function(usr) {
          inner_deferred.resolve(usr);
        })
        .fail(function(usr_err) {
          if(sc.authRequired) {
            var errorObj = new ErrorObj(403,
                                        'bs0003',
                                        __filename,
                                        'requestPipeline',
                                        'unauthorized',
                                        'Unauthorized',
                                        null);
            inner_deferred.reject(errorObj);
          }
          else {
            inner_deferred.resolve(null);
          }
        });
      }
    }
    else {
      inner_deferred.resolve(null);
    }

    return [sc, validTokenResponse, inner_deferred.promise];
  })
  .spread(function (sc, validTokenResponse, userOrNull) {
    //PUT THE USER OBJECT ON THE REQUEST
    if(userOrNull !== null) {
      req.this_user = userOrNull;
    }
    if (sc.authRequired) {
      return [sc, validTokenResponse, accessControl.verifyAccess(req, sc)];
    }
    else {
      return [sc, validTokenResponse];
    }
  })
  .spread(function (sc, validTokenResponse) {
    return [sc, validTokenResponse, serviceRegistration.validateArguments(serviceCall, area, controller, verb, version, args)];
  })
  .spread(function (sc, validTokenResponse) {
    return [validTokenResponse, mainController.resolveServiceCall(sc, req)];
  })
  .spread(function (validTokenResponse, results) {
    if(validTokenResponse.session != null) {
      let session = validTokenResponse.session;
      session.last_touch = new Date().toISOString();
      dataAccess.saveEntity('session', session);
    }

    // IF ACCESS LOGGING IS ENABLED.  ADD THE END TIMESTAMP
    // AND RESPONSE STATUS NUM TO THE ACCESS LOG EVENT AND
    // WRITE IT TO THE LOG
    if(settings.data.access_logging === true) {
      accessLogEvent.end_timestamp = new Date().toISOString();
      accessLogEvent.http_status = 200;
      let logEntry = JSON.stringify(accessLogEvent)+'\n';
      accessLog.write(logEntry);
    }

    if(results && results.express_download === true){
      if(results.download_name){
        res.status(200).download(results.download_path, results.download_name);
      }
      else {
        res.status(200).download(results.download_path);
      }
    }
    else {
      res.status(200).send(results);
    }
    
  })
  .fail(function (err) {
    if (err.http_status == null) {
      err.http_status = 500;
    }

    if (err.message == null || err.message.length === 0) {
      err['message'] = 'Something went wrong and we are working to fix it. Please try again later.'
    }

    // IF ACCESS LOGGING IS ENABLED.  ADD THE END TIMESTAMP
    // AND RESPONSE STATUS NUM TO THE ACCESS LOG EVENT AND
    // WRITE IT TO THE LOG
    if(settings.data.access_logging === true) {
      accessLogEvent.end_timestamp = new Date().toISOString();
      accessLogEvent.http_status = err.http_status;
      let logEntry = JSON.stringify(accessLogEvent)+'\n';
      accessLog.write(logEntry);
    }

    let errorLogEntry = JSON.stringify(err) + '\n';
    errorLog.write(errorLogEntry);

    res.status(err.http_status).send(err);
  });
}

// -----------------------------------
// SWITCH ERROR LOGS AT MIDNIGHT
// -----------------------------------
function changeErrorLogs() {
  let today = new Date();
  var monthNum = today.getMonth()+1;
  var monthString = monthNum < 10 ? '0'+monthNum : monthNum;
  var dateString = today.getDate() < 10 ? '0'+today.getDate() : today.getDate();
  let todayString = monthString+'-'+dateString+'-'+today.getFullYear();
  let errorLogPath = './logs/error-'+todayString;
  let accessLogPath = './logs/access-'+todayString;
  let sessionLogPath = './logs/session-'+todayString;
  let eventLogPath = './logs/event-'+todayString;
  

  var newErrorLog = fs.createWriteStream(errorLogPath, {flags:'a'});
  var newEventLog = fs.createWriteStream(eventLogPath, {flags:'a'});
  var newAccessLog = null;
  if(settings.data.access_logging === true)
    newAccessLog = fs.createWriteStream(accessLogPath, {flags:'a'});
  var newSessionLog = null;
  if(settings.data.session_logging === true)
    newSessionLog = fs.createWriteStream(sessionLogPath, {flags:'a'});


  if(errorLog != null) errorLog.end();
  errorLog = newErrorLog;

  if(eventLog != null) eventLog.end();
  eventLog = newEventLog;

  if(settings.data.access_logging === true) {
    if(accessLog != null) accessLog.end();
    accessLog = newAccessLog;
  }
  else {
    accessLog = null;
  }

  if(settings.data.session_logging === true) {
    if(sessionLog != null) sessionLog.end();
    sessionLog = newSessionLog;
  }
  else {
    sessionLog = null;
  }
  

  // DELETE LOGS OLDER THAN today - log_rotation_period
  var evictionDate = new Date();
  evictionDate.setDate(evictionDate.getDate()-settings.data.log_rotation_period);
  evictionDate.setHours(0,0,0,0);
  fs.readdir('./logs/', (err, files) => {
    if(!err) {
      for(var fIdx = 0; fIdx < files.length; fIdx++) {
        let filepath = './logs/'+files[fIdx];
        fs.stat(filepath, (stat_err, stats) => {
          if(!stat_err) {
            var createDate = new Date(stats.birthtime);
            createDate.setHours(0,0,0,0);
            if(createDate < evictionDate) {
              fs.unlink(filepath, (del_err, del_res) => {
                if(del_err) {
                  var errObj = {
                    display_message:"Problem evicting log files",
                    file: filepath,
                    timestamp: new Date(),
                    results: del_err
                  }
                  let logEntry = JSON.stringify(errObj)+'\n';
                  errorLog.write(logEntry);
                }
              })
            }
          }
          else {
            var errObj = {
              display_message:"Problem evicting log files",
              file: filepath,
              timestamp: new Date(),
              results: stat_err
            }
            let logEntry = JSON.stringify(errObj)+'\n';
            errorLog.write(logEntry);
          }
        })
      }
    }
    else {
      var errObj = {
        display_message:"Problem evicting log files",
        timestamp: new Date(),
        results: err
      }
      let logEntry = JSON.stringify(errObj)+'\n';
      errorLog.write(logEntry);
    }
  })

  var midnightTonight = new Date();
  midnightTonight.setDate(midnightTonight.getDate()+1);
  midnightTonight.setHours(0, 0, 0, 0);
  var rightNow = new Date();
  var interval = midnightTonight.getTime() - rightNow.getTime();
  setTimeout(changeErrorLogs, interval);

  return;
}

// -----------------------------------
// PRINT OBJECT AS JSON TO CONSOLE
// -----------------------------------
function printObject(obj) {
	console.log(JSON.stringify(obj, null, 4));
}


// ----------------------------------------
// CHECK FOR SESSIONS WHICH HAVE TIMED OUT
// ----------------------------------------
function checkForInvalidSessions(dataAccess, settings, callback) {
	var deferred = Q.defer();
	//THIS RETURNS STALE SESSIONS
	dataAccess.GetDeadSessions(settings.data.timeout)
	.then(function (deadSessions) {
    var dsIds = [];
    // IF LOGGING SESSIONS, WRITE OUT THE DEAD SESSIONS TO
    // THE SESSION LOG
    for(var sIdx = 0; sIdx < deadSessions.length; sIdx++) {
      let dsid = "'"+deadSessions[sIdx].rid+"'";
      dsIds.push(dsid);
      
      if(settings.data.session_logging === true) {
        let dsObj = {
          session_id: deadSessions[sIdx].data.id,
          token: deadSessions[sIdx].data.token,
          user_id: deadSessions[sIdx].data.user_id,
          started_at: deadSessions[sIdx].data.started_at,
          ended_at: new Date()
        }
        var logEntry = JSON.stringify(dsObj)+'\n';
        sessionLog.write(logEntry);
      }
    }

    if(dsIds.length > 0) {
      dataAccess.DeleteSessions(dsIds)
      .then(function(res) {
        deferred.resolve();
      })
      .fail(function(err) {
        let logEntry = JSON.stringify(err)+'\n';
        errorLog.write(logEntry);
        deferred.resolve();
      })
    }
    else {
      deferred.resolve();
    }
	});
	deferred.promise.nodeify(callback);
	return deferred.promise;
}