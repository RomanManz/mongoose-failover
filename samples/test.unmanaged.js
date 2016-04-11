'use strict';

var opts = process.env.DEBUG && process.env.DEBUG.match(/mongodb/) ? { mongodb: { debug: true } } : null,
	failover = require('../index.js')(opts),
	debug = require('debug')('failover:client'),
	cluster = new failover.unmanaged('test.unmanaged'),
	workQueue = [],
	interval = 1000,
	master = false;

cluster.on('statechange', (oldState, newState) => {
	console.log(`cluster state change ${oldState} => ${newState}...`);
	master = newState === 'master';
});

cluster.on('synchronize', sync);

cluster.on('error', err => {
	console.log(`cluster recoverable error: ${err}\n${err.stack}`);
});

cluster.on('fatal', err => {
	console.log(`cluster fatal error: ${err}\n${err.stack}`);
});

cluster.run();

setInterval(() => {
	workQueue.push({ name: 'workItem', id: parseInt( new Date().getTime() / 1000 ) });
	doWork();
}, interval);

function doWork() {
	var currentId;
	if( master ) {
		// naive approach, if work requires some asynchronous calls, doWork() should be protected by a lock (see lib/managed.js)
		for( let item = null; workQueue.length && ( item = workQueue.splice(0, 1)[0] ); ) {
			debug(`master working on item ${item.id}...`);
			currentId = item.id;
		}
		if( currentId ) cluster.synchronize(currentId);
	}
}

function sync(id) {
	// another approach could be to leave the items on the queue during doWork() and perform the queue cleanup
	// here in master mode as well
	// that's why a 'synchronize' is emmitted also in master mode
	if( master ) return;
	debug(`slave received synchronization with id ${id}...`);
	for( let i = 0, item = null; item = workQueue[i]; i++ ) {
		if( item.id == id ) { // ignore type safety
			debug('slave clearing ' + ( i + 1 ) + ' items...');
			workQueue.splice(0, i + 1);
			break;
		}
	}
}
