var Q = require('q');
var fs = require('fs');
var async = require('async');
var PG = require('pg');
var crypto = require('crypto');
var dataAccess;

module.exports = {
	updateSchema: function (modelsJs, name, user, pass, host, port, utilities) {
		var deferred = Q.defer();
		dataAccess = utilities.getDataAccess();
		checkDbExists(name, user, pass, host, port)
    .then(function () {
      return dataAccess.getDbConnection();
    })
    .then(function (connection) {
      return [connection, createInitialTables(connection, name, user, pass, host, port)];
    })
    .spread(function (connection, cit_res) {
      return [connection, makeTables(connection, modelsJs.data.models, name, user, pass, host, port)];
    })
    .spread(function (connection, res) {
      return [res, dataAccess.closeDbConnection(connection)];
    })
    .spread(function (commit_res) {
      return [createDefaultUser(name, user, pass, host, port, utilities)];
    })
    .then(function (res) {
      deferred.resolve(res);
    })
    .fail(function (err) {
      if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
        deferred.reject(err.AddToError(__filename, 'updateSchema'));
      }
      else {
        var errorObj = new ErrorObj(500,
          'sc1001',
          __filename,
          'updateSchema',
          'error updating schema',
          'Database error',
          err
        );
        deferred.reject(errorObj);
      }
    });

		return deferred.promise;
	}
}

// MAKE THE SYSTEM TABLES
function createInitialTables(connection, name, user, pass, host, port) {
  var deferred = Q.defer();

  //var modelTables = ['bsuser', 'session', 'internal_system'];
  var tbls = require('./InitialTables');
  var modelTables = [tbls.credentials, tbls.session, tbls.bsuser];
  var linkingTables = [{ 
    'linking_table': 'bsuser_session', 
    'left_table': 'bsuser', 
    'right_table': 'session' 
  }];
  var toOneRels = [{
    "relates_to": "credentials",
    "plural_name": "credentials",
    "relates_from": "bsuser",
    "plural_rev": "bsusers",
    "foreign_table": "credentials",
    "to_one": true
  }];

	Q.all(modelTables.map(function (mt) {
    var inner_deferred = Q.defer();

		checkForTable(connection, mt.object_type)
    .then(function (tableExists) {
      if (!tableExists) {
        createTable(connection, mt)
        .then(function (ct_res) {
          inner_deferred.resolve();
        })
        .fail(function (ct_err) {
          if (ct_err !== undefined && ct_err !== null && typeof (ct_err.AddToError) === 'function') {
            inner_deferred.reject(ct_err.AddToError(__filename, 'createInitialTables'));
          }
          else {
            var errorObj = new ErrorObj(500,
              'sc1002',
              __filename,
              'createInitialTables',
              'error creating tables',
              'Database error',
              ct_err
            );
            inner_deferred.reject(errorObj);
          }
        });
      }
      else {
        inner_deferred.resolve();
      }
    })
    .fail(function (err) {
      if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
        inner_deferred.reject(err.AddToError(__filename, 'createInitialTables'));
      }
      else {
        var errorObj = new ErrorObj(500,
          'sc1003',
          __filename,
          'createInitialTables',
          'error creating tables',
          'Database error',
          err
        );
        inner_deferred.reject(errorObj);
      }
    });

		return inner_deferred.promise;
	}))
  .then(function () {
    return Q.all(linkingTables.map(function (lDetails) {
      var inner_deferred = Q.defer();

      var tableName = lDetails.linking_table;
      var leftTable = lDetails.left_table;
      var rightTable = lDetails.right_table;

      checkForTable(connection, tableName)
      .then(function (tableExists) {
        if (tableExists) {
          inner_deferred.resolve();
        }
        else {
          createLinkingTable(connection, tableName, leftTable, rightTable)
          .then(function (ct_res) {
            inner_deferred.resolve();
          })
          .fail(function (err) {
            if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
              inner_deferred.reject(err.AddToError(__filename, 'createInitialTables'));
            }
            else {
              var errorObj = new ErrorObj(500,
                'sc1004',
                __filename,
                'createInitialTables',
                'error creating tables',
                'Database error',
                err
              );
              inner_deferred.reject(errorObj);
            }
          });
        }
      })
      .fail(function (err) {
        if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
          inner_deferred.reject(err.AddToError(__filename, 'createInitialTables'));
        }
        else {
          var errorObj = new ErrorObj(500,
            'sc1005',
            __filename,
            'createInitialTables',
            'error creating tables',
            'Database error',
            err
          );
          inner_deferred.reject(errorObj);
        }
      });

      return inner_deferred.promise;
    }));
  })
  .then(function(ct_res) {
    return Q.all(toOneRels.map(function (rel) {
      var inner_deferred = Q.defer();

      getColumnAndType(connection, rel.relates_from, rel.relates_to)
      .then(function(dataType) {
        if(dataType === null) {
          // COLUMN DOESN'T EXIST
          return addToOneRelationship(connection, rel.relates_from, rel);
        }
        else {
          // FOR NOW JUST MOVE ON.  LATER WE MIGHT CHECK THE DATA TYPE
          return null;
        }
      })
      .then(function(addRel_res) {
        inner_deferred.resolve();
      })
      .fail(function(inner_err) {
        inner_deferred.reject(inner_err.AddToError(__filename,'createInitialTables'));
      })

      return inner_deferred.promise;
    }));
  })
  .then(function () {
    deferred.resolve('success');
  })
  .fail(function (err) {
    if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
      deferred.reject(err.AddToError(__filename, 'createInitialTables'));
    }
    else {
      var errorObj = new ErrorObj(500,
        'sc1006',
        __filename,
        'createInitialTables',
        'error creating tables',
        'Database error',
        err
      );
      inner_deferred.reject(errorObj);
    }
  });

	return deferred.promise;
}

function createDefaultUser(name, user, pass, host, port, utilities) {
	var deferred = Q.defer();
	var qry = "SELECT * FROM bsuser WHERE data #>> '{username}' = 'bsroot'";
	var qry_params = [];
	dataAccess.ExecutePostgresQuery(qry, qry_params, null)
		.then(function (connection) {
			if (connection.results.length === 0) {
				// FIX THIS PROMISE CHAIN AND ADD A FAIL BLOCK
				utilities.getUID()
					.then(function (uid_res) {
						var cryptoCall = Q.denodeify(crypto.randomBytes);
						cryptoCall(48)
							.then(function (buf) {
								var salt = buf.toString('hex');
								var saltedPassword = 'abcd@1234' + salt;
								var hashedPassword = crypto.createHash('sha256').update(saltedPassword).digest('hex');
								var token = crypto.randomBytes(48).toString('hex');
								var userObj = {
									'object_type': 'bsuser',
									'id': uid_res,
									'created_at': new Date().toISOString(),
									'username': 'bsroot',
									'first': '',
									'last': '',
									'email': 'bsroot@backstrap.io',
									'salt': salt,
									'password': hashedPassword,
									'is_active': true,
									'forgot_password_tokens': [token]
								};
								var roles = ['super-user'];
								userObj['roles'] = roles;
								qry = "INSERT INTO \"bsuser\"(\"data\") VALUES($1)";
								qry_params = [userObj];
								dataAccess.ExecutePostgresQuery(qry, qry_params, null)
									.then(function (connection) {
										deferred.resolve(connection);
									})
									.fail(function (err) {
										var errorObj = new ErrorObj(500,
											'sc1007',
											__filename,
											'createDefaultUser',
											'error creating default user',
											'Database error',
											err
										);
										deferred.reject(errorObj);
									})
							});

					});
			}
			else {
				deferred.resolve(true);
			}
		})
		.fail(function (err) {
			var errorObj = new ErrorObj(500,
				'sc1008',
				__filename,
				'createDefaultUser',
				'error creating default user',
				'Database error',
				err
			);
			deferred.reject(errorObj);
		});

	return deferred.promise;
}

function makeTables(connection, models, name, user, pass, host, port) {
	var deferred = Q.defer();
	var allModels = models;

	var tableList = [];
	var linkingTableList = [];
  var linkingDetails = [];
  var toOneRels = [];

	// GET NAMES OF ALL TABLES USING object_type and relationships.linking_table
	// MAKE SURE WE DON'T ADD THEM TWICE
	for (var model in allModels) {
		var m = allModels[model];
		if (tableList.indexOf(m.object_type) == -1) {
			tableList.push(m.object_type);
		}

		for (var rel in m.relationships) {
      var r = m.relationships[rel];

      // IF THIS IS A TO-ONE RELATIONSHIP
      if(r.to_one === true) {
        r.object_type = m.object_type;
        toOneRels.push(r)
      }
      else if (linkingTableList.indexOf(r.linking_table) == -1) {
        linkingTableList.push(r.linking_table);

        // PUSH THE RELATES_TO TABLE TO THE TABLE LIST TO CHECK FOR EXISTENCE
        if (tableList.indexOf(r.relates_to) == -1 && (r.relates_to.toLowerCase() !== 'user' && r.relates_to.toLowerCase() !== 'account')) {
          tableList.push(r.relates_to);
        }

        var lDetails = {
          'linking_table': r.linking_table
        };
        if (r.relates_to === 'bsuser') {
          lDetails.left_table = m.object_type;
          lDetails.right_table = 'bsuser';
        }
        else {
          // LINKING TABLE MUST BE NAMED USING THE TWO TABLE NAMES THAT IT JOINS
          var computedLinkingTableName = r.relates_to + '_' + m.object_type;
          if (r.linking_table === computedLinkingTableName) {
            lDetails.left_table = r.relates_to;
            lDetails.right_table = m.object_type;
          }
          else {
            lDetails.left_table = m.object_type;
            lDetails.right_table = r.relates_to;
          }
        }
        linkingDetails.push(lDetails);
      }
		}
	}

	Q.all(tableList.map(function (tableName) {
		var inner_deferred = Q.defer();
		checkForTable(connection, tableName)
    .then(function (tableExists) {
      if (tableExists) {
        inner_deferred.resolve();
      }
      else {
        createTable(connection, tableName)
        .then(function (ct_res) {
          inner_deferred.resolve();
        })
        .fail(function (err) {
          if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
            inner_deferred.reject(err.AddToError(__filename, 'makeTables'));
          }
          else {
            var errorObj = new ErrorObj(500,
              'sc1009',
              __filename,
              'makeTables',
              'error making tables',
              'Database error',
              err
            );
            inner_deferred.reject(errorObj);
          }
        });
      }
    })
    .fail(function (err) {
      if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
        inner_deferred.reject(err.AddToError(__filename, 'makeTables'));
      }
      else {
        var errorObj = new ErrorObj(500,
          'sc1010',
          __filename,
          'makeTables',
          'error making tables',
          'Database error',
          err
        );
        inner_deferred.reject(errorObj);
      }
    });

		return inner_deferred.promise;
	}))
  .then(function () {
    return Q.all(linkingDetails.map(function (lDetails) {
      var inner_deferred = Q.defer();

      var tableName = lDetails.linking_table;
      var leftTable = lDetails.left_table;
      var rightTable = lDetails.right_table;

      checkForTable(connection, tableName)
      .then(function (tableExists) {
        if (tableExists) {
          inner_deferred.resolve();
        }
        else {
          createLinkingTable(connection, tableName, leftTable, rightTable)
          .then(function (ct_res) {
            inner_deferred.resolve();
          })
          .fail(function (err) {
            if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
              inner_deferred.reject(err.AddToError(__filename, 'makeTables'));
            }
            else {
              var errorObj = new ErrorObj(500,
                'sc1011',
                __filename,
                'makeTables',
                'error making tables',
                'Database error',
                err
              );
              inner_deferred.reject(errorObj);
            }
          });
        }
      })
      .fail(function (err) {
        if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
          inner_deferred.reject(err.AddToError(__filename, 'makeTables'));
        }
        else {
          var errorObj = new ErrorObj(500,
            'sc1012',
            __filename,
            'makeTables',
            'error making tables',
            'Database error',
            err
          );
          inner_deferred.reject(errorObj);
        }
      });

      return inner_deferred.promise;
    }));
  })
  .then(function(ct_res) {
    return Q.all(toOneRels.map(function (rel) {
      var inner_deferred = Q.defer();

      getColumnAndType(connection, rel.object_type, rel.relates_to)
      .then(function(dataType) {
        if(dataType === null) {
          // COLUMN DOESN'T EXIST
          return addToOneRelationship(connection, rel.object_type, rel);
        }
        else {
          // FOR NOW JUST MOVE ON.  LATER WE MIGHT CHECK THE DATA TYPE
          return null;
        }
      })
      .then(function(addRel_res) {
        inner_deferred.resolve();
      })
      .fail(function(inner_err) {
        inner_deferred.reject(inner_err.AddToError(__filename,'makeTables'));
      })
    }));
  })
  .then(function () {
    deferred.resolve(true);
  })
  .fail(function (err) {
    if (err !== undefined && err !== null && typeof (err.AddToError) === 'function') {
      deferred.reject(err.AddToError(__filename, 'makeTables'));
    }
    else {
      var errorObj = new ErrorObj(500,
        'sc1013',
        __filename,
        'makeTables',
        'error making tables',
        'Database error',
        err
      );
      inner_deferred.reject(errorObj);
    }
  });

	return deferred.promise;
}

function checkForTable(connection, tableName) {
	var deferred = Q.defer();

	var qry = "SELECT EXISTS ( " +
		"SELECT 1 " +
		"FROM   pg_catalog.pg_class c " +
		"JOIN   pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
		"WHERE  n.nspname = 'public' " +
		"AND    c.relname = '" + tableName + "' " +
		"AND    c.relkind = 'r' " +
		");";

	var qry_params = [];
	dataAccess.ExecutePostgresQuery(qry, qry_params, connection)
		.then(function (connection) {
			deferred.resolve(connection.results[0].exists);
		})
		.fail(function (err) {
			var errorObj = new ErrorObj(500,
				'sc0008',
				__filename,
				'checkForTable',
				'error querying postgres',
				'Database error',
				err
			);
			deferred.reject(errorObj);
		});

	return deferred.promise;
}

function createTable(connection, tableDesc) {
  var deferred = Q.defer();
  var tableName = tableDesc.object_type;
  var props = tableDesc.properties;
  var rels = tableDesc.relationships;

	var qry = "CREATE TABLE " + tableName + " ( " +
    "row_id SERIAL PRIMARY KEY, " +
    "id VARCHAR(50) NOT NULL UNIQUE, " +
    "object_type VARCHAR(50) DEFAULT '"+tableName+"', " +
    "is_active BOOLEAN DEFAULT true, " +
    "created_at TIMESTAMP, " +
    "updated_at TIMESTAMP, " +
    "deleted_at TIMESTAMP, " +
    "data JSONB, ";
    
  
  let tablesToSkip = ['bsuser', 'credentials', 'session'];
  if(!tablesToSkip.includes(tableName)) {
    qry += "owner VARCHAR(50), " +
            "permittedUsers JSONB, " +
            "permittedGroups JSONB, ";
  }
  
  var relationalProps = props.filter((p) => p.nosql !== true);
  for(var pIdx = 0; pIdx < relationalProps.length; pIdx++) {
    let p = relationalProps[pIdx];
    qry += p.name + ' ';
    if(p.hasOwnProperty('db_type') && p['db_type'] != null) {
      qry += p['db_type'];
    }
    else {
      if(p.data_type === 'object' || p.data_type === 'array') {
        qry += 'JSONB';
      }
      else if(p.data_type === 'number') {
        qry += 'DOUBLE';
      }
      else if(p.data_type === 'file') {
        qry += 'TEXT';
      }
      else if(p.data_type === 'boolean') {
        qry += 'BOOLEAN';
      }
      else if(p.data_type === 'date') {
        qry += 'VARCHAR(24)';
      }
      else if(p.data_type === 'string') {
        qry += 'TEXT';
      }
    }

    if(p.unique === true) {
      qry += ' UNIQUE';
    }

    if(p.require === true) {
      qry += ' NOT NULL';
    }

    if(pIdx < relationalProps.length-1) { 
      qry += ', ';
    }
  }

  qry += ');'

  var qry_params = [];
	dataAccess.ExecutePostgresQuery(qry, qry_params, connection)
	.then(function (connection) {
		var indexQry  = 'CREATE INDEX ON '+ tableName + ' USING gin (data);';
		return dataAccess.ExecutePostgresQuery(indexQry, [], connection);
  })
  .then(function (connection) {
		var indexQry  = 'CREATE INDEX ON '+ tableName + ' (id);';
		return dataAccess.ExecutePostgresQuery(indexQry, [], connection);
	})
	.then(function(connection) {
		deferred.resolve();
	})
	.fail(function (err) {
		var errorObj = new ErrorObj(500,
			'sc0010',
			__filename,
			'createTable',
			'error creatinng table in postgres',
			'Database error',
			err
		);
		deferred.reject(errorObj);
	});

	return deferred.promise;
}

function createLinkingTable(connection, tableName, leftTable, rightTable) {
	var deferred = Q.defer();
	var qry = "CREATE TABLE " + tableName + " ( " +
		"row_id SERIAL PRIMARY KEY, " +
		"left_id VARCHAR(50) NOT NULL REFERENCES " + leftTable + "(id), " +
		"right_id VARCHAR(50) NOT NULL REFERENCES " + rightTable + "(id), " +
		"rel_type TEXT, " +
		"rel_props JSONB" +
		");";
	var qry_params = [];

	dataAccess.ExecutePostgresQuery(qry, qry_params, connection)
	.then(function (connection) {
		var indexQry  = 'CREATE INDEX ON '+ tableName + ' (left_id, right_id); '+
						'CREATE INDEX ON '+ tableName + '(right_id, left_id);';
		return dataAccess.ExecutePostgresQuery(indexQry, [], connection);
	})
	.then(function(connection) {
		deferred.resolve();
	})
	.fail(function (err) {
		var errorObj = new ErrorObj(500,
			'sc0012',
			__filename,
			'createLinkingTable',
			'error creating table in postgres',
			'Database error',
			err
		);
		deferred.reject(errorObj);
	});

	return deferred.promise;
}

function addToOneRelationship(connection, tableName, relationship) {
  var deferred = Q.defer();
  var qry = "ALTER TABLE " + tableName + " ADD COLUMN " + relationship.relates_to +
             " VARCHAR(50) REFERENCES " + relationship.foreign_table + "(id)";
	var qry_params = [];

	dataAccess.ExecutePostgresQuery(qry, qry_params, connection)
	.then(function (connection) {
		deferred.resolve();
	})
	.fail(function (err) {
		var errorObj = new ErrorObj(500,
			'sc0015',
			__filename,
			'addToOneRelationship',
			'error inserting column',
			'Database error',
			err
		);
		deferred.reject(errorObj);
	});

	return deferred.promise;
}

function getColumnAndType(connection, tableName, columnName) {
  var deferred = Q.defer();
  var qry = "SELECT data_type FROM information_schema.columns WHERE \
            table_name = '"+tableName+"' AND column_name = '"+columnName+"'";
	var qry_params = [];

	dataAccess.ExecutePostgresQuery(qry, qry_params, connection)
	.then(function (connection) {
		if(connection.results.length > 0) {
      deferred.resolve(connection.results[0].data_type);
    }
    else {
      deferred.resolve(null);
    }
	})
	.fail(function (err) {
		var errorObj = new ErrorObj(500,
			'sc0016',
			__filename,
			'getColumnAndType',
			'error checking column existance and type',
			'Database error',
			err
		);
		deferred.reject(errorObj);
	});

	return deferred.promise;
}

function checkDbExists(db_name, db_user, db_pass, db_host, db_port) {
	var deferred = Q.defer();
	dataAccess.CreateDatabase(db_name, db_user, db_pass, db_host, db_port)
		.spread(function (err, res) {
			//BECAUSE events.js THROWS AN UNHANDLED EXCEPTION WHEN 
			//QUERYING A DB THAT DOESNT EXIST, WE CANNOT DO SELECT 1 FROM pg_database WHERE datname = '" + db_name + "'
			//SO WE JUST CREATE AND IGNORE IF ERRORS BECAUSE IT EXISTS
			//42P04 == Database already exists
			if (err && err.code !== '42P04') {
				var errorObj = new ErrorObj(500,
					'sc0013',
					__filename,
					'checkDbExists',
					'error checking to see if database exists and creating if not',
					'Database error',
					err
				);
				deferred.reject(errorObj);
			}
			else {
				deferred.resolve();
			}
		})
		.fail(function (err) {
			var errorObj = new ErrorObj(500,
				'sc0014',
				__filename,
				'getDatabase',
				'error connecting to postgres',
				'Database error',
				err
			);
			deferred.reject(errorObj);
		});

	return deferred.promise;
};
