'use strict';

var mongoose = require('mongoose');

module.exports = function(options) {
	options = options || {};
	if( options.debug ) mongoose.set('debug', true);
	if( options.connectOptions ) {
		if( options.connectOptions.db ) options.connectOptions.db.bufferMaxEntries = 0;
		else options.connectOptions.db = { bufferMaxEntries: 0 };
		if( options.connectOptions.server ) options.connectOptions.server.reconnectTries = Number.MAX_VALUE;
		else options.connectOptions.server = { reconnectTries: Number.MAX_VALUE };
	}
	return mongoose.connect(options.connectString || 'mongodb://localhost:27017/test', options.connectOptions || { db: { bufferMaxEntries: 0 }, server: { reconnectTries: Number.MAX_VALUE } });
};
