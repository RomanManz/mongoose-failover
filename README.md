# mongoose-failover

Simple failover service for low-volume subsystems.
I've been told that when you ask yourself the question about
how to synchronize your subsystem instances you've done
a mistake ... which is probably correct.
But still, even just for fun.

## Purpose

This is a kind of mini cluster service that synchronizes itself
through a MongoDB using Mongoose.
There is no built-in mechanism (yet) to persist the work itself
in the database so data might get lost.
The synchronization in 'managed' mode (see below) is implemented
as a FIFO, but during a 'failover' single tasks may be executed
twice (if the synchronization was not complete).

## Installation

* npm
```
npm install RomanManz/mongoose-failover
```

* git
```
git clone https://github.com/RomanManz/mongoose-failover.git
```

## Prerequisites

You need to have a MongoDB and NodeJS installed.
Some ES6 syntax is used, tested with NodeJS 5.1.

## Usage

### Unmanaged mode

In this mode the failover instance only takes care of the synchronization.
The feeding of the identifiers and the coordination of the work needs to
be implemented in the client (see samples/test.unmanaged.js).

Invoking it from your client program:
```
var failover = require('failover')(opts) // for opts see options below
var cluster = new failover.unmanaged(<a unique name for your subsystem shared btw. all instances>);

// registering for events (see below)
// You need to register for 'synchronize' to let your slave know the
// current execution order of your server (if that applies to your app).
// The master instance should run synchronize() calls on the failover
// object which gets forwarded to the slave with every synchronization.

cluster.run();
```

Running the demo:
```
cd <your copy of the repo>
node samples/test.unmanaged.js
```

### Managed mode

In this mode the failover instance takes care of queueing the work,
synchronizing the tasks between the master and the slave and
coordinating the execution of the work sequentially.
Still the workQueue needs to be filled in on both sides, slave and master.

Invoking it from your client program
```
var failover = require('failover')(opts); // options see below
var cluster = new failover.managed(<unique subsystem name>, <synchronization key>, <work execution callback>);

// optionally register for events like statechange to do logging for example

cluster.run();

//

// somewhere feed work (object)
cluster.submitWork(<task object>);
```

### options passed to the failover

- mongodb
-- connectString -> the database connect string, defaults to mongodb://localhost:27017/test
-- connectOptions -> the connect options, defaults to { db: { bufferMaxEntries: 0 }, server: { reconnectTries: Number.MAX_VALUE } }
-- debug -> runs mongoose.set('debug', true)
- nodb -> uses simple counters, just for debugging, useless in regular mode
- intervals -> object containing interval values overriding the defaults (see below)

### synchronization key

The tasks passed into submitWork() are expected to be regular javascript objects.
The 'key' is used to synchronize the workQueues between the master and the slave.
If it is a string it is expected a key of the task objects and its value is used,
a callback function is also accepted which is executed for each new task to retrieve the id.

### work execution callback

A callback that is executed by the failover instance in master mode for every task on the queue.
To be able to run the tasks sequentially and to check for the return values, that callback
needs to return a Promise object.
It is ecpected that the work callback resolve()s always with either boolean true in which case
the task gets removed from the queue, or with boolean false in which case the task gets
retried in the next iteration.
If the Promise is reject()ed the task is also kept in the queue and retried.

The work callback is called whenever a new task gets in. A lock secures the function from getting called
several times in parallel guaranteeing for a sequential execution.
The work continues until all tasks are worked off, unless there is an error in between
(the Promise is rejected or resolved with false) or there was a failover in between.
The latter should only happen if the failover service does not get a tick to send a synchronization event.

### default intervals

- INIT: 0 -> the first test is run immediately
- MASTER: 2000 -> in master mode a synchronization event is sent every 2 secs. (containing the current work id)
- SLAVE: 2500 -> giving the master a bit of time
- TICKING: 2000 -> if the slave gets no update from the master in time, a second test is done before taking over
- ERROR: 5000 -> if the database connection is broken every 5 seconds a retry is done; actually we could simply wait
for a reconnect event from the database driver, but this just fits in so nicely

### debugging

The debug npm package is used.
- failover* logs everything
- failover:tests logs the master/slave tests
- failover:states logs state changes
- failover:managed logs sync/work activities in managed mode
- failover:client logs client activities running the samples
- mongodb enables mongoose debugging in the samples (sets the options.mongodb.debug flag)

### events triggered

- synchronize -> emits the newest task id
- error -> emits error with the database connection
- info -> emits database connected events
- panic -> something wrong internally
- statechange -> emits oldState, newState information after a state change
- master -> when an instances was elected master
- slave -> when an instances was elected slave

