'use strict';

var opts = process.env.DEBUG && process.env.DEBUG.match(/mongodb/) ? { mongodb: { debug: true } } : null,
	failover = require('../index.js')(opts),
	debug = require('debug')('failover:client'),
	cluster = new failover.managed('test.managed', 'id', doWork),
	cnt = 0,
	interval = 1000;

cluster.on('statechange', (oldState, newState) => {
	console.log(`cluster state change ${oldState} => ${newState}...`);
});

cluster.on('error', err => {
	console.log(`cluster recoverable error: ${err}\n${err.stack}`);
});

cluster.on('fatal', err => {
	console.log(`cluster fatal error: ${err}\n${err.stack}`);
});

cluster.run();

setInterval(() => {
	cluster.submitWork({ name: 'workItem', id: parseInt( new Date().getTime() / 1000 ) });
}, interval);

function doWork(task) {
	return new Promise((resolve, reject) => {
		debug(`working on task ${task.id}`);
		if( !( ++cnt % 10 ) ) {
			setTimeout(() => {
				// reject confuses the failover because it does not know if it should keep the task (retry) or discard.
				// Doing it here to demo that rejected tasks are kept in the queue and retried.
				reject(new Error('Demo reject'));
			}, 5000);
		} else {
			resolve(true);
		}
	});
}
