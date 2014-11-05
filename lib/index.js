var APIBuilder = require('apibuilder'),
	_ = require('lodash'),
	fs = require('fs'),
	path = require('path'),
	jsforce = require('jsforce'),
	async = require('async'),
	pkginfo = require('pkginfo')(module),
	pkginfo = module.exports,
	moment = require('moment'),
	Connector = APIBuilder.Connector,
	Collection = APIBuilder.Collection,
	Instance = APIBuilder.Instance;

// --------- in memory DB connector -------

module.exports = Connector.extend({

	// generated configuration
	config: APIBuilder.Loader(),
	name: 'salesforce',
	pkginfo: _.pick(pkginfo, 'name', 'version', 'description', 'author', 'license', 'keywords', 'repository'),
	logger: APIBuilder.createLogger({}, { name: 'salesforce', useConsole: true, level: 'debug' }),

	// implementation

	constructor: function constructor() {
	},
	fetchConfig: function fetchConfig(next) {
		if (!this.config.requireSessionLogin) {
			this.logger.warn('config.requireSessionLogin is turned off; requests can use the global salesforce authentication.');
		}
		next(null, this.config);
	},
	fetchMetadata: function fetchMetadata(next) {
		next(null, {
			fields: [
				APIBuilder.Metadata.URL({
					name: 'url',
					description: 'url for connector',
					required: true,
					default: 'https://login.salesforce.com'
				}),
				APIBuilder.Metadata.Text({
					name: 'username',
					description: 'username for login',
					required: true
				}),
				APIBuilder.Metadata.Password({
					name: 'password',
					description: 'password for login',
					required: true,
					validator: /[a-z\d]{3,}/i
				}),
				APIBuilder.Metadata.Text({
					name: 'token',
					description: 'token for login',
					required: true,
					validator: /[a-z\d]{15,}/i
				})
			]
		});
	},
	fetchSchema: function fetchSchema(next) {
		var confDir = path.join(__dirname, '..', 'conf'),
			cachedFileName = path.join(confDir, 'schema.json');
		fs.exists(cachedFileName, function schemaExists(exists) {
			if (exists) {
				this.logger.debug('cached schema file found', cachedFileName);
				var stats = fs.statSync(cachedFileName),
					ago = Date.now() - stats.ctime,
					refresh = +stats.ctime + this.config.schemaRefresh;

				this.logger.debug('cached schema file',
					'last update =', moment(stats.ctime).fromNow(), 
					'&& time to refresh =', moment(refresh).fromNow());
				// if we generated the file < refresh time, we can reuse it
				if (this.config.schemaRefresh && this.config.schemaRefresh >= ago) {
					return fs.readFile(cachedFileName, function readFile(err, buf) {
						if (err) { return next(err); }
						return next(null, JSON.parse(buf.toString()));
					});
				}
			}
			this.logger.debug('schema file not found, will generate');
			var schemaGen = require('./schema');
			schemaGen.generate(this.config, this.logger, this.connection, confDir, next);
		}.bind(this));
		// refresh the schema on a schedule if set
		var timeout = this.config.schemaRefresh || (60000 * 30);
		if (this.config.schemaRefresh) {
			setTimeout(function refreshTimer() {
				fs.unlink(cachedFileName, function fetchSchemaTimer() {
					this.fetchSchema();
				}.bind(this));
			}.bind(this), timeout);
		}
	},
	loginRequired: function loginRequired(request, next) {
		if (!request.headers || !request.headers.accesstoken) {
			next(null, true);
		}
		else {
			var headers = request.headers || {},
				opts = getOpts(this.config, headers);
			
			this.connection = new jsforce.Connection(opts);
			next(null, false);
		}
	},
	login: function login(request, next) {
		var headers = request.headers || {},
			opts = getOpts(this.config, headers),
			username = headers.user,
			password = headers.pass + headers.token;

		if (!headers.user || !headers.pass || !headers.token) {
			if (this.requireSessionLogin) {
				return next('Authentication is required. Please pass these headers: user, pass, and token; or accessToken.');
			}
			else {
				return next();
			}
		}

		this.connection = new jsforce.Connection(opts);
		this.connection.login(username, password, function loginCallback(err, userInfo) {
			if (err) {
				return next(err);
			}
			// TODO: How do we get this token back to the user so they needn't login every time?
			console.log('Access Token: ' + this.connection.accessToken);
			return next();
		}.bind(this));
	},
	connect: function connect(next) {
		var opts = getOpts(this.config),
			username = this.config.username,
			password = this.config.password + this.config.token;
		
		this.connection = new jsforce.Connection(opts);
        this.connection.login(username, password, function connectLoginCallback(err, userInfo) {
			if (err) { return next(err); }
			else { return next(); }
		}.bind(this));
	},
	disconnect: function disconnect(next) {
		this.logger.info('disconnect');
		if (this.connection) {
			this.connection.logout(function logoutTask() {
				this.connection = null;
				next();
			}.bind(this));
		}
	},
	query: function(Model, options, next) {
		try {
			if (_.isFunction(options)) {
				next = options;
				options = null;
			}
			if (!options) {
				options = { where: {} };
			}

			var object = getObject(Model, this.connection),
				connector = this,
				keys = Model.keys(),
				fields = {};
			for (var i = 0; i < keys.length; i++) {
				fields[keys[i]] = 1;
			}
			fields.Id = 1;

			if (options.page && options.per_page) {
				// Translate page/per_page to skip/limit, because that's what SF can handle.
				options.skip = (options.page - 1) * options.per_page;
				options.limit = options.per_page;
			}
			if (options.unsel) {
				return next('"unsel" is not currently supported by the Salesforce connector.');
			}
			
			var chain = object.find(options.where, options.sel || fields);
			if (options.sort) {
				var sort = {};
				options.sort.split(',').forEach(function(property) {
					if (property[0] === '-') {
						sort[property.substr(1)] = -1;
					}
					else {
						sort[property] = 1;
					}
				});
				chain = chain.sort(sort);
			}
			chain = chain.limit(options.limit || 10);
			if (options.skip) {
				chain = chain.skip(options.skip);
			}

			chain.execute(function findCallback(err, records) {
				if (err) { return handleError(connector, err, next); }
				var array = records.map(function recordMapper(record) {
					var result = _.omit(record, 'attributes'),
						instance = Model.instance(result, true);
					instance.setPrimaryKey(record.Id || record.id);
					return instance;
				});
				next(null, new Collection(Model, array));
			});
		}
		catch (E) {
			return handleError(this, E, next);
		}
	},
	findOne: function findOne(Model, id, next) {
		try {
			var object = getObject(Model, this.connection),
				connector = this;
			object.retrieve(id, function retrieveCallback(err, record) {
				if (err) { return handleError(connector, err, next); }
				var result = _.omit(record, 'attributes'),
					instance = Model.instance(result, true);
				instance.setPrimaryKey(result.Id || result.id);
				next(null, instance);
			});
		}
		catch (E) {
			return handleError(this, E, next);
		}
	},
	findAll: function findAll(Model, next) {
		try {
			var query = 'SELECT Id, ' + Model.keys().join(',') + ' FROM ' + getObjectName(Model),
				connector = this;
			this.connection.query(query, function queryCallback(err, result) {
				if (err) { return handleError(connector, err, next); }
				
				var array = result.records.map(function recordMapper(record) {
					var result = _.omit(record, 'attributes'),
						instance = Model.instance(result, true);
					instance.setPrimaryKey(record.Id || record.id);
					return instance;
				});
				next(null, new Collection(Model, array));
			});
		}
		catch (E) {
			return handleError(this, E, next);
		}
	},
	create: function create(Model, values, next) {
		try {
			var object = getObject(Model, this.connection),
				connector = this;
			object.create(values, function createCallback(err, result) {
				if (err) { return handleError(connector, err, next); }
				else { return connector.findOne(Model, result.Id || result.id, next); }
			});
		}
		catch (E) {
			return handleError(this, E, next);
		}
	},
	save: function save(Model, instance, next) {
		try {
			var object = getObject(Model, this.connection),
				connector = this,
				record = _.merge({ Id: instance.getPrimaryKey() }, instance.values());
			object.update(record, function saveCallback(err, result) {
				if (err) { return handleError(connector, err, next); }
				else { return connector.findOne(Model, result.Id || result.id, next); }
			});
		}
		catch (E) {
			return handleError(this, E, next);
		}
	},
	delete: function(Model, instance, next) {
		try {
			var object = getObject(Model, this.connection),
				connector = this;
			object.destroy(instance.getPrimaryKey(), function destroyCallback(err, result) {
				if (err) { return handleError(connector, err, next); }
				next(null, instance);
			});
		}
		catch (E) {
			return handleError(this, E, next);
		}
	},
	deleteAll: function(Model, next) {
		try {
			var connector = this;
			connector.findAll(Model, function(err, results) {
				async.series(results.toArray().map(function(result) {
					return function(callback) {
						connector.delete(Model, result, function(err) {
							if (err) {
								console.error(err);
							}
							callback();
						});
					};
				}), next);
			});
		}
		catch (E) {
			return handleError(this, E, next);
		}
	}

});

// utilities only needed for this connector

function handleError(connector, err, next) {
	/*if (err.errorCode === 'NOT_FOUND') {
		return connector.notFound(next);
	}*/
	return next(err);
}

/**
 * return the object based on the model name or configured from metadata
 */
function getObject(model, connection) {
	var name = getObjectName(model),
		obj = connection.sobject(name);
	if (!obj) {
		throw new Error('invalid SF object named:' + name);
	}
	return obj;
}

/**
 * Returns the object name based on the model's meta object or, failing that, name property.
 * @param model
 * @returns {*|model.name}
 */
function getObjectName(model) {
	return model.getMeta('object') || model.name;
}

/**
 * Returns a properly populated jsForce constructor dictionary based on the provided config and headers.
 * @param config
 * @param headers
 * @returns {{loginUrl: *, logLevel: (*|exports.logLevel|opts.logLevel), accessToken: *, instanceUrl: *}}
 */
function getOpts(config, headers) {
	if (!headers) {
		headers = {};
	}
	return {
		loginUrl: headers.loginurl || config.url,
		logLevel: config.logLevel,
		accessToken: headers.accesstoken,
		instanceUrl: headers.instanceurl || config.instanceUrl
	};
}