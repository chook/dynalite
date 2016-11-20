var http = require('http'),
		https = require('https'),
		fs = require('fs'),
		path = require('path'),
		url = require('url'),
		util = require('util'),
		pad = require('pad'),
		stringify = require('node-stringify'),
		crypto = require('crypto'),
		crc32 = require('buffer-crc32'),
		validations = require('./validations'),
		db = require('./db'),
		dynaliteLogger = require('./logger'),
		stats = require('./stats');

var MAX_REQUEST_BYTES = 16 * 1024 * 1024
var logger
var statistics

var validApis = ['DynamoDB_20111205', 'DynamoDB_20120810'],
		validOperations = ['BatchGetItem', 'BatchWriteItem', 'CreateTable', 'DeleteItem', 'DeleteTable',
			'DescribeTable', 'GetItem', 'ListTables', 'PutItem', 'Query', 'Scan', 'UpdateItem', 'UpdateTable'],
		actions = {},
		actionValidations = {}

module.exports = dynalite

function dynalite(options) {
	options = options || {}
	var server, stores = {}, requestHandler = httpHandler.bind(null, stores, options)

	logger = dynaliteLogger.createLogger("dynalite_log", __dirname, options)
	
	if (options.memoryStats) {
		setInterval(function() {
			try {
				logger.info("Process Memroy Stats: " + stringify(process.memoryUsage()));
			} catch (e) {
				logger.error("Error printing Memroy Stats " + e);
			}
			
		}, options.memoryStats * 1000);
	}
	
	statistics = stats.createStats()

	if (options.ssl) {
		options.key = options.key || fs.readFileSync(path.join(__dirname, 'ssl', 'server-key.pem'))
		options.cert = options.cert || fs.readFileSync(path.join(__dirname, 'ssl', 'server-crt.pem'))
		options.ca = options.ca || fs.readFileSync(path.join(__dirname, 'ssl', 'ca-crt.pem'))
		server = https.createServer(options, requestHandler)
	} else {
		server = http.createServer(requestHandler)
	}
	
	if (logger) logger.info("Server Created...")

	// Ensure we close DB when we're closing the server too
	var httpServerClose = server.close, httpServerListen = server.listen
	server.close = function(cb) {
		if (logger) logger.info("Shutting Down Dynalite Server...")
			
		for (var i = 0; i < stores.length; i++)
		{
			var store = stores[i];

			store.db.close(function(err) {
				if (err) return cb(err)
				// Recreate the store if the user wants to listen again
				server.listen = function() {
					store.recreate()
					httpServerListen.apply(server, arguments)
				}
				httpServerClose.call(server, cb)
		 })
		}
	}

	return server
}

validOperations.forEach(function(action) {
	action = validations.toLowerFirst(action)
	actions[action] = require('./actions/' + action)
	actionValidations[action] = require('./validations/' + action)
})

function rand52CharId() {
	// 39 bytes turns into 52 base64 characters
	var bytes = crypto.randomBytes(39)
	// Need to replace + and / so just choose 0, obvs won't be truly random, whatevs
	return bytes.toString('base64').toUpperCase().replace(/\+|\//g, '0')
}

function sendData(req, res, data, statusCode) {
	var body = JSON.stringify(data)
	req.removeAllListeners()
	res.statusCode = statusCode || 200
	res.setHeader('x-amz-crc32', crc32.unsigned(body))
	res.setHeader('Content-Type', res.contentType)
	res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))
	// AWS doesn't send a 'Connection' header but seems to use keep-alive behaviour
	// res.setHeader('Connection', '')
	// res.shouldKeepAlive = false
	res.end(body)
	// TODO: do we want this? -> if (logger) logger.debug({body: body}, "Sending data.")
}

function httpHandler(stores, options, req, res) {
	var body
	req.on('error', function(err) { throw err })
	req.on('data', function(data) {
		var newLength = data.length + (body ? body.length : 0)
		if (newLength > MAX_REQUEST_BYTES) {
			req.removeAllListeners()
			res.statusCode = 413
			res.setHeader('Transfer-Encoding', 'chunked')
			return res.end()
		}
		body = body ? Buffer.concat([body, data], newLength) : data
	})
	req.on('end', function() {

		body = body ? body.toString() : ''

		// All responses after this point have a RequestId
		res.setHeader('x-amzn-RequestId', rand52CharId())

		if (req.headers.origin) {
			res.setHeader('Access-Control-Allow-Origin', '*')

			if (req.method == 'OPTIONS') {
				if (req.headers['access-control-request-headers'])
					res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'])

				if (req.headers['access-control-request-method'])
					res.setHeader('Access-Control-Allow-Methods', req.headers['access-control-request-method'])

				res.setHeader('Access-Control-Max-Age', 172800)
				res.setHeader('Content-Length', 0)
				req.removeAllListeners()
				return res.end()
			}
		}

		if (req.url == "/stats") {
			var curStats = statistics.getCounters()
			if (curStats)
			{
				req.removeAllListeners()
				res.statusCode = 200
				res.setHeader('x-amz-crc32', 3128867991)
				res.setHeader('Content-Length', curStats.length)
				return res.end(curStats)
			}
		}

		if (req.method == 'GET') {
			req.removeAllListeners()
			res.statusCode = 200
			res.setHeader('x-amz-crc32', 3128867991)
			res.setHeader('Content-Length', 42)
			return res.end('healthy: dynamodb.us-east-1.amazonaws.com ')
		}

		var contentType = (req.headers['content-type'] || '').split(';')[0].trim()

		if (req.method != 'POST' ||
				(body && contentType != 'application/json' && contentType != 'application/x-amz-json-1.0')) {
			req.removeAllListeners()
			res.statusCode = 404
			res.setHeader('x-amz-crc32', 3552371480)
			res.setHeader('Content-Length', 29)
			return res.end('<UnknownOperationException/>\n')
		}

		// TODO: Perhaps don't do this
		res.contentType = contentType != 'application/x-amz-json-1.0' ? 'application/json' : contentType

		// THEN check body, see if the JSON parses:

		var data
		if (body) {
			try {
				data = JSON.parse(body)
			} catch (e) {
				return sendData(req, res, {__type: 'com.amazon.coral.service#SerializationException'}, 400)
			}
		}

		var target = (req.headers['x-amz-target'] || '').split('.')

		if (target.length != 2 || !~validApis.indexOf(target[0]) || !~validOperations.indexOf(target[1]))
			return sendData(req, res, {__type: 'com.amazon.coral.service#UnknownOperationException'}, 400)

		var authHeader = req.headers.authorization
		var query = url.parse(req.url, true).query
		var authQuery = 'X-Amz-Algorithm' in query

		if (authHeader && authQuery)
			return sendData(req, res, {
				__type: 'com.amazon.coral.service#InvalidSignatureException',
				message: 'Found both \'X-Amz-Algorithm\' as a query-string param and \'Authorization\' as HTTP header.',
			}, 400)

		if ((!authHeader && !authQuery) || (authHeader && (authHeader.trim().slice(0, 5) != 'AWS4-')))
			return sendData(req, res, {
				__type: 'com.amazon.coral.service#MissingAuthenticationTokenException',
				message: 'Request is missing Authentication Token',
			}, 400)

		var msg = '', params

		if (authHeader) {
			// TODO: Go through key-vals first
			// "'Credential' not a valid key=value pair (missing equal-sign) in Authorization header: 'AWS4-HMAC-SHA256 \
			// Signature=b,    Credential,    SignedHeaders'."
			params = ['Credential', 'Signature', 'SignedHeaders']
			var authParams = authHeader.split(/,| /).slice(1).filter(Boolean).reduce(function(obj, x) {
				var keyVal = x.trim().split('=')
				obj[keyVal[0]] = keyVal[1]
				return obj
			}, {})
			params.forEach(function(param) {
				if (!authParams[param])
					// TODO: SignedHeaders *is* allowed to be an empty string at this point
					msg += 'Authorization header requires \'' + param + '\' parameter. '
			})
			if (!req.headers['x-amz-date'] && !req.headers.date)
				msg += 'Authorization header requires existence of either a \'X-Amz-Date\' or a \'Date\' header. '
			if (msg) msg += 'Authorization=' + authHeader

		} else {
			params = ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Signature', 'X-Amz-SignedHeaders', 'X-Amz-Date']
			params.forEach(function(param) {
				if (!query[param])
					msg += 'AWS query-string parameters must include \'' + param + '\'. '
			})
			if (msg) msg += 'Re-examine the query-string parameters.'
		}

		if (msg) {
			if (logger) logger.error("Incomplete Signature Exception in httpHandler()")
			return sendData(req, res, {
				__type: 'com.amazon.coral.service#IncompleteSignatureException',
				message: msg,
			}, 400)
		}
		// THEN check Date format and expiration
		// {"__type":"com.amazon.coral.service#IncompleteSignatureException","message":"Date must be in ISO-8601 'basic format'. \
		// Got '201'. See http://en.wikipedia.org/wiki/ISO_8601"}
		// {"__type":"com.amazon.coral.service#InvalidSignatureException","message":"Signature expired: 20130301T000000Z is \
		// now earlier than 20130609T094515Z (20130609T100015Z - 15 min.)"}
		// THEN check Host is in SignedHeaders (not case sensitive)
		// {"__type":"com.amazon.coral.service#InvalidSignatureException","message":"'Host' must be a 'SignedHeader' in the AWS Authorization."}
		// THEN check Algorithm
		// {"__type":"com.amazon.coral.service#IncompleteSignatureException","message":"Unsupported AWS 'algorithm': \
		// 'AWS4-HMAC-SHA25' (only AWS4-HMAC-SHA256 for now). "}
		// THEN check Credential (trailing slashes are ignored)
		// {"__type":"com.amazon.coral.service#IncompleteSignatureException","message":"Credential must have exactly 5 \
		// slash-delimited elements, e.g. keyid/date/region/service/term, got 'a/b/c/d'"}
		// THEN check Credential pieces, all must match exact case, keyid checking throws different error below
		// {"__type":"com.amazon.coral.service#InvalidSignatureException","message":\
		// "Credential should be scoped to a valid region, not 'c'. \
		// Credential should be scoped to correct service: 'dynamodb'. \
		// Credential should be scoped with a valid terminator: 'aws4_request', not 'e'. \
		// Date in Credential scope does not match YYYYMMDD from ISO-8601 version of date from HTTP: 'b' != '20130609', from '20130609T095204Z'."}
		// THEN check keyid
		// {"__type":"com.amazon.coral.service#UnrecognizedClientException","message":"The security token included in the request is invalid."}
		// THEN check signature (requires body - will need async)
		// {"__type":"com.amazon.coral.service#InvalidSignatureException","message":"The request signature we calculated \
		// does not match the signature you provided. Check your AWS Secret Access Key and signing method. \
		// Consult the service documentation for details.\n\nThe Canonical String for this request should have \
		// been\n'POST\n/\n\nhost:dynamodb.ap-southeast-2.amazonaws.com\n\nhost\ne3b0c44298fc1c149afbf4c8996fb92427ae41e46\
		// 49b934ca495991b7852b855'\n\nThe String-to-Sign should have been\n'AWS4-HMAC-SHA256\n20130609T\
		// 100759Z\n20130609/ap-southeast-2/dynamodb/aws4_request\n7b8b82a032afd6014771e3375813fc995dd167b7b3a133a0b86e5925cb000ec5'\n"}
		// THEN check X-Amz-Security-Token if it exists
		// {"__type":"com.amazon.coral.service#UnrecognizedClientException","message":"The security token included in the request is invalid"}

		// THEN check types (note different capitalization for Message and poor grammar for a/an):

		// THEN validation checks (note different service):
		// {"__type":"com.amazon.coral.validate#ValidationException","message":"3 validation errors detected: \
		// Value \'2147483647\' at \'limit\' failed to satisfy constraint: \
		// Member must have value less than or equal to 100; \
		// Value \'89hls;;f;d\' at \'exclusiveStartTableName\' failed to satisfy constraint: \
		// Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+; \
		// Value \'89hls;;f;d\' at \'exclusiveStartTableName\' failed to satisfy constraint: \
		// Member must have length less than or equal to 255"}

		// For some reason, the serialization checks seem to be a bit out of sync
		if (!body)
		{
			if (logger) logger.error("Serialization Exception Occurred in httpHandler()")
			return sendData(req, res, {__type: 'com.amazon.coral.service#SerializationException'}, 400)
		}

		var action = validations.toLowerFirst(target[1])
		var actionValidation = actionValidations[action]
		
		var timerId = Math.floor((Math.random() * 2147483647) + 1).toString()
		var logTableName = data.TableName

		if ((!logTableName) &&
				(data.RequestItems))
		{
			logTableName = Object.keys(data.RequestItems).join(", ")
		}

		if (!logTableName)
		{
			logTableName = "allTables"
		}

		var actionStartTime = new Date().getTime()
		
		statistics.incCounter(action + "-" + logTableName)

		var store = getStore(stores, options, action, data)

		try {
			data = validations.checkTypes(data, actionValidation.types)
			validations.checkValidations(data, actionValidation.types, actionValidation.custom, store)
		} catch (e) {
			if (e.statusCode)
			{
				if (logger) logger.error({exData: e.body}, "Error while validating data for action: " + action)
				return sendData(req, res, e.body, e.statusCode)
			}
			throw e
		}

		var actionInFlight;
		
		try {
			actionInFlight = createActionInFlight(action, data);
		} catch (e) {
			actionInFlight = {tableName:"error", data:stringify(e)};
		}

		actions[action](store, data, function(err, data) {
			if (logger)
			{
				var actionTimeMs = new Date().getTime() - actionStartTime
				logAction(action, data, actionInFlight, actionTimeMs);
			}

			if (err && logger)
			{
				logger.error({exData: data}, "[TIMER: " + timerId + "] Error while trying to perform action: " + action + " on " + logTableName + " with error: " + err)
			}
			
			if (err && err.statusCode)
			{
				return sendData(req, res, err.body, err.statusCode)
			}
			if (err) throw err
			sendData(req, res, data)
		})
	})
}

function createActionInFlight(action, data) {
	if (!data) {
		return {tableName:"", data:""};
	}
	
	var tableName = "";
	var details = "";
	
	if (action == "createTable") {
		tableName = data.TableName;
		details = stringify(data.KeySchema)
	} else if (action == "describeTable") {
		tableName = data.TableName;
	} else if (action == "getItem") {
		tableName = data.TableName;
		details = stringify(data.Key);
	} else if (action == "query") {
		tableName = data.TableName;
		details = stringify(data.KeyConditions);
	} else if (action == "batchGetItem") {
		if (Object.keys(data.RequestItems) == 1) {
			tableName = Object.keys(data.RequestItems)[0];
		} else {
			tableName = Object.keys(data.RequestItems);
		}
		
		details = stringify(data.RequestItems);
	} else if (action == "updateItem") {
		tableName = data.TableName;
		details = stringify(data.Key) + stringify(data.AttributeUpdates)
	} else if (action == "putItem") {
		tableName = data.TableName;
		details = stringify(data.Item);
	} else if (action == "batchWriteItem") {
		if (Object.keys(data.RequestItems) == 1) {
			tableName = Object.keys(data.RequestItems)[0];
		} else {
			tableName = Object.keys(data.RequestItems);
		}
		
		details = stringify(data.RequestItems);
	} else if (action == "deleteItem") {
		tableName = data.TableName;
		details = stringify(data.Key)
	} else if (action == "scan") {
		tableName = data.TableName;
		details = stringify(data);
	} else {
		if (data.TableName) {
			tableName = data.TableName;
		}
		
		details = stringify(data);
	}
	
	return {tableName:tableName, details:details}
}

function logAction(action, data, preData, actionTimeMs) {
	var details = preData.details;
	var tableName = preData.tableName;
	
	try {
		if ((data) && (action == "describeTable") && (data.Table)) {
			details = "status: " + data.Table.TableStatus;
		}
	} catch (e) {
		details = stringify(e);
	}
	
	if (!tableName) {
		tableName = "null";
	}
	
	if (!details) {
		details = "";
	}

	var formattedMessage = util.format("%s\t%s\t%s\t%s", 
		pad(actionTimeMs + "ms", 8),
		pad(action, 20),
		pad(tableName, 45),
		details);
	
	logger.info(formattedMessage);
}

function getStore(stores, options, action, data)
{
	var table
	
	if (options.flat_layout)
	{
		table = ""
	}
	else
	{
		table = getTableName(action, data)
	}
	
	var store = stores[table];
	
	if (store == null)
	{
		var newOptions = {}
		
		for (var i in options) 
		{
				newOptions[i] = options[i];
		}
		
		newOptions.path = newOptions.path + "/" + table
		store = db.create(newOptions);
	}
	
	stores[table] = store;
	return store
}

function getTableName(action, data)
{
	if (!data)
	{
		console.log("Data is null, Aborting!");
		return;
	}
	
	if (!action)
	{
		console.log("Action is null, Aborting!");
		return;
	}
	
	if ((action == "batchWriteItem") ||
			(action == "batchGetItem"))
	{
		for (var tableName in data.RequestItems)
		{
			return tableName;
		} 
	}
	else if (data.TableName != null)
	{
		return data.TableName;
	}

	console.log(action)
	console.log(data)
}

if (require.main === module) dynalite().listen(4567)
