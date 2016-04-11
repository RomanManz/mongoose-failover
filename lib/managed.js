'use strict';

/**
 * The worker is expected to always resolve()!
 * If it resolves to true, the task gets removed from the workQueue,
 * otherwise it remains and the work() is done until a new task is entered into the queue.
 * If the worker gets rejected - unexpectedly - the same applies as if it was resolved falsely.
 * This gives the worker the possibility to decide which error should be retried and which
 * one ignored.
*/

var co = require('co'),
	failover = require('./failover').failover,
	debug = require('debug')('failover:managed');

class managed extends failover {
	constructor(name, key, worker) {
		super(name);
		this.key = key;
		this.workQueue = [];
		this.workLock = false;
		this.worker = worker;
		this.master = false;
		this.on('statechange', (oldState, newState) => {
			this.master = newState === 'master';
		});
		this.on('synchronize', id => {
			this.sync(id);
		});
	}
	submitWork(task) {
		var id = typeof this.key === 'function' ? this.key(task) : task[this.key];
		debug(`new task with id ${id} received`);
		this.workQueue.push({ id, task });
		if( this.master ) this.work();
	}
	work() {
		if( this.workLock ) return;
		this.workLock = true;
		var that = this; // no fat arrows for generators :-/
		co(function*() {
			// It is well possible that new tasks are added during the loop below, so repeat until empty.
			stopme: while( that.workQueue.length ) {
				debug(`master workQueue size: ${that.workQueue.length}`);
				// 'var task' instead of 'let task' to make it visible inside the Promise's then()
				for( var task = null; that.workQueue.length && ( task = that.workQueue.splice(0, 1)[0] ); ) {
					debug(`master delegating task ${task.id}...`);
					var doNext = yield that.worker(task.task).then(success => {
						if( ! success) {
							debug(`worker returned failure, putting task ${task.id} back into the queue`);
							that.workQueue.splice(0, 0, task);
							return false;
						} else if( ! that.master ) {
							// this can happen if the worker runs synchronously longer than INTERVAL.SLAVE + INTERVAL.TICKING (roughly)
							debug('totally unexpectedly lost master mode');
							return false;
						} else {
							that.synchronize(task.id);
							return true;
						}
					}, err => {
						debug(`received unexpected worker error for task ${task.id}, putting the task back into the queue`);
						that.workQueue.splice(0, 0, task);
						return false;
					});
					if( ! doNext ) break stopme;
				}
			}
		}).catch(err => { debug('Oops, totally unexpected error: ' + err + err.stack); }).then(() => { that.workLock = false; });
	}
	sync(id) {
		if( this.master ) return;
		if( id === null ) return; // init
		debug(`slave received synchronize event with id ${id}`);
		for( let i = 0, task = null; task = this.workQueue[i]; i++ ) {
			if( task.id == id ) { // ignore type safety
				debug('slave clearing ' + ( i + 1 ) + ' tasks...');
				this.workQueue.splice(0, i + 1);
				break;
			}
		}
	}
}

module.exports = function(options) {
	return managed;
};
