'use strict';

var failover = require('./failover').failover;

class unmanaged extends failover {
	constructor(name, identifier) {
		super(name, identifier);
	}
}

module.exports = function(options) {
	return unmanaged;
};
