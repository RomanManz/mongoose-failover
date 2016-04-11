'use strict';

var mongoose = require('mongoose'),
	moment = require('moment'),
	EventEmitter = require('events'),
	debug = require('debug')('failover'),
	db = require('./db'),
	debugTests = require('debug')('failover:tests'),
	debugStates = require('debug')('failover:states'),
	hostname = require('os').hostname(),
	schema = new mongoose.Schema({
		name: { type: String, required: true },
		member: { type: String, required: true },
		identifier: String,
		lastSeen: { type: Date, required: true }
	}),
	model = mongoose.model('failover', schema),
	stateObjects = {},
	opts = {},
	test = { cnt: 0 };
const STATES = {
		ERROR: -1,
		FALSE: 0,
		TRUE: 1
	}, INTERVALS = {
		INIT: 0,
		MASTER: 2000,
		SLAVE: 2500,
		TICKING: 2000,
		ERROR: 5000,
	};

// don't set the intervals above this
schema.index({ name: 1, lastSeen: 1 }, { expireAfterSeconds: 600 });
model.ensureIndexes(function(err) { /* don't know where to log... */ });

function slaveTest(failover) {
	debugTests('testing slave mode');
	var payload = failover.payload;
	return new Promise((resolve, reject) => {
		model.findOne({ name: payload.name, lastSeen: { $gt: moment().subtract(INTERVALS.MASTER, 'milliseconds').toDate() } }, (err, doc) => {
			if( err ) return reject(err);
			if( doc && payload.identifier !== doc.identifier ) {
				payload.identifier = doc.identifier;
				failover.emit('synchronize', doc.identifier);
			}
			resolve(!!doc);
		});
	});
}

function _slaveTest(failover) {
	debugTests('testing slave mode');
	return new Promise((resolve, reject) => {
		resolve(!!test.cnt--);
	});
}

function masterTest(failover) {
	debugTests('testing master mode');
	var payload = failover.payload;
	return new Promise((resolve, reject) => {
		model.findOneAndUpdate({ name: payload.name, lastSeen: { $gt: moment().subtract(INTERVALS.MASTER, 'milliseconds').toDate() } }, { $setOnInsert: { name: payload.name, member: payload.member, identifier: payload.identifier, lastSeen: moment().toDate() } }, { new: true, upsert: true }, (err, doc) => {
			if( err ) return reject(err);
			if( doc.member === payload.member ) failover.emit('synchronize', doc.identifier);
			resolve(doc.member === payload.member);
		});
	});
}

function _masterTest(failover) {
	debugTests('testing master mode');
	return new Promise((resolve, reject) => {
		resolve(test.cnt++ !== 5);
	});
}

/**
 * state.interval === 0 will execute with the next tick.
*/
function runOnce(failover) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			resolve(this.runner(failover).then(result => ~~result, err => { this.error = err; return STATES.ERROR }));
		}, this.interval);
	});
}

/**
 * It is not a problem if the calls overtake each other in exceptional cases,
 * presumed that the tests have a decent (and working) timeout.
 * The first one to return wins the Promise.
 * However the intervals should not be chosen too small...
*/
function runUntilChange(failover) {
	return new Promise((resolve, reject) => {
		var stopper = setInterval(() => {
			this.runner(failover).then(result => {
				if( ~~result !== this.state ) {
					clearInterval(stopper);
					resolve(~~result);
				}
			}, err => {
				if( this.state !== STATES.ERROR ) {
					clearInterval(stopper);
					this.error = err;
					resolve(STATES.ERROR);
				}
			});
		}, this.interval);
	});
}

class state {
	constructor(name, state, interval, starter, runner) {
		this.name = name;
		this.state = state;
		this.interval = interval;
		this.starter = starter;
		this.runner = runner;
		this.triggers = {};
		this.error = null;
	}
	enter(failover, oldState) {
		return this.starter(failover);
	}
	setTriggers(triggers) {
		this.triggers = triggers;
	}
}

class errorState extends state {
	constructor(name, state, interval, starter, runner) {
		super(name, state, interval, starter, runner);
	}
	enter(failover, oldState) {
		this.triggers = oldState.triggers;
		this.runner = oldState.runner;
		return super.enter(failover, oldState);
	}
}

/**
 * init race condition
 * If the failover is started while the mongodb is down, the first findAndModify() call does only return
 * once the connection is up, although buffMaxEntries is set to 0 (db.js).
 * So if the mongodb is down and two instances of the failover are started but with a time difference of
 * > INTERVALS.MASTER the calls look like this:
 * failover instance1: findAndModify({ lastSeen: { $gt: x ... ,{ $setOnInsert: { lastSeen: x + INTERVALS.MASTER ...)
 * failover instance2: findAndModify({ lastSeen: { $gt: y ... ,{ $setOnInsert: { lastSeen: y + INTERVALS.MASTER ...)
 * with y - x > INTERVALS.MASTER
 * Once the db connection is up instance1 wins because there is no entry > x,
 * instance2 wins as well because instance1's insert is still < y!
 * To handle this, init is followed by ticking upon success and not directly by master.
 * Once the database connection is up subsequent connection errors seem to be handled properly without further race conditions.
 * However in some rare cases this may still be not true.
 *
 * runtime race condition
 * On high CPU load situations or if the client's worker takes > INTERVALS.SLAVE + INTERVALS.TICKING to finish (synchronous)
 * the slave might take over which leads to potential double-processing of one or more tasks!
*/
class failover extends EventEmitter {
	constructor(name, identifier) {
		super();
		this.payload = {
			name: name,
			member: `${hostname}:${process.pid}`,
			identifier: identifier || null
		};
		this.state = null;
		if( ! opts.nodb ) {
			// Without this line an error during startup kills the app - WHY?
			mongoose.connection.on('error', err => { debug('mongodb error ' + err); if( this.state !== STATES.ERROR ) this.emit('error', err); });
			mongoose.connection.on('timeout', () => { debug('mongodb timeout...'); if( this.state !== STATES.ERROR ) this.emit('error', new Error('timeout')); });

			// Without this line a recovered broken connection cannot be restored - WHY?
			mongoose.connection.on('connected', () => { debug('mongodb connected...'); this.emit('info', 'connected'); });
		}
	}
	run() {
		debug('initializing');
		if( ! opts.nodb ) db(opts.mongodb);
		if( ! stateObjects.init ) return this.emit('panic', new Error('Oops, no init state found.'));
		this.switch({ name: 'boot' }, stateObjects.init);
	}
	synchronize(identifier) {
		this.payload.identifier = identifier;
	}
	switch(oldstate, newstate) {
		debugStates(`changing state from ${oldstate.name} to ${newstate.name}`);
		this.state = newstate.state;
		this.emit('statechange', oldstate.name, newstate.name);
		this.emit(newstate.name, oldstate.error);
		newstate.enter(this, oldstate).then(nextstate => {
			if( ! newstate.triggers[nextstate] ) {
				failover.emit('panic', new Error(`Oops, unknown next state ${nextstate} on state ${newstate.name}.`));
			} else {
				this.switch(newstate, newstate.triggers[nextstate]);
			}
		}, (err) => {
			// totally unexpected :-/
			this.emit('panic', err);
		});
	}
}

stateObjects.init = new state('init', null, INTERVALS.INIT, runOnce, masterTest);
stateObjects.master = new state('master', STATES.TRUE, INTERVALS.MASTER, runUntilChange, masterTest);
stateObjects.slave = new state('slave', STATES.TRUE, INTERVALS.SLAVE, runUntilChange, slaveTest);
stateObjects.ticking = new state('ticking', STATES.FALSE, INTERVALS.TICKING, runOnce, masterTest);
stateObjects.error = new errorState('error', STATES.ERROR, INTERVALS.ERROR, runUntilChange); // runner is assigned at runtime
// see init race condition above, as of why a successful init still needs to do ticking
stateObjects.init.setTriggers({ [STATES.TRUE]: stateObjects.ticking, [STATES.FALSE]: stateObjects.slave, [STATES.ERROR]: stateObjects.error });
stateObjects.master.setTriggers({ [STATES.TRUE]: stateObjects.master, [STATES.FALSE]: stateObjects.slave, [STATES.ERROR]: stateObjects.error });
stateObjects.slave.setTriggers({ [STATES.TRUE]: stateObjects.slave, [STATES.FALSE]: stateObjects.ticking, [STATES.ERROR]: stateObjects.error });
stateObjects.ticking.setTriggers({ [STATES.TRUE]: stateObjects.master, [STATES.FALSE]: stateObjects.slave, [STATES.ERROR]: stateObjects.error });
// The error object's triggers are assigned at runtime.
// stateObjects.error.setTriggers({ [STATES.TRUE]: stateObjects.master, [STATES.FALSE]: stateObjects.slave, [STATES.ERROR]: stateObjects.error });

function init(options) {
	options = options || {};
	opts = options;
	for( let opt in options.intervals ) {
		if( stateObjects[opt.toLowerCase()] ) stateObjects[opt.toLowerCase()].interval = options.intervals[opt.toLowerCase()];
		if( INTERVALS[opt.toUpperCase()] ) INTERVALS[opt.toUpperCase()] = options.intervals[opt.toUpperCase()];
	}
	if( options.nodb ) {
		masterTest = _masterTest;
		slaveTest = _slaveTest;
	}
}

module.exports = {
	init,
	failover
};
