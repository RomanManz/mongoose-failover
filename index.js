'use strict';

var failover = require('./lib/failover');

module.exports = function(options) {
	failover.init(options);
	return {
		managed: require('./lib/managed')(options),
		unmanaged: require('./lib/unmanaged')(options)
	};
};
