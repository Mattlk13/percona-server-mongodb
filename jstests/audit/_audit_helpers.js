import {ReplSetTest} from "jstests/libs/replsettest.js";
import {ShardingTest} from "jstests/libs/shardingtest.js";

export function getDBPath() {
    return MongoRunner.dataDir !== undefined ? MongoRunner.dataDir : '/data/db';
}

export function auditTest(name, fn, serverParams) {
    let loudTestEcho = function(msg) {
        const s =
            `----------------------------- AUDIT UNIT TEST: ${msg} -----------------------------`;
        print(Array(s.length + 1).join('-'));
        print(s);
    };

    loudTestEcho(`${name} STARTING`);
    const dbpath = getDBPath();
    const auditPath = dbpath + '/auditLog.json';
    removeFile(auditPath);
    let port = allocatePorts(1);
    let conn;
    let startServer = function(extraParams) {
        let params = Object.merge(mongodOptions(serverParams), extraParams);
        if (serverParams === undefined || serverParams.config === undefined) {
            params = Object.merge(
                {auditDestination: 'file', auditPath: auditPath, auditFormat: 'JSON'}, params);
        }
        conn = MongoRunner.runMongod(Object.merge({
            port: port,
            dbpath: dbpath,
        },
                                                  params));
        return conn;
    };
    let stopServer = function() {
        MongoRunner.stopMongod(conn);
    };
    let restartServer = function() {
        stopServer();
        return startServer({noCleanData: true});
    };
    try {
        fn(startServer(), restartServer);
    } finally {
        MongoRunner.stopMongod(conn);
    }
    loudTestEcho(`${name} PASSED`);
}

export function auditTestRepl(name, fn, serverParams) {
    let loudTestEcho = function(msg) {
        const s = `----------------------------- AUDIT REPL UNIT TEST: ${
            msg} -----------------------------`;
        print(Array(s.length + 1).join('-'));
        print(s);
    };

    loudTestEcho(`${name} STARTING`);
    let replTest = new ReplSetTest({
        name: 'auditTestReplSet',
        cleanData: true,
        nodes: 2,
        nodeOptions: mongodOptions(serverParams)
    });
    replTest.startSet({auditDestination: 'file'});
    let config = {
        _id: 'auditTestReplSet',
        members: [
            {_id: 0, host: getHostName() + ":" + replTest.ports[0], priority: 2},
            {_id: 1, host: getHostName() + ":" + replTest.ports[1], priority: 1},
        ]
    };
    replTest.initiate(config);
    fn(replTest);
    loudTestEcho(`${name} PASSED`);
}

export function auditTestShard(name, fn, serverParams) {
    let loudTestEcho = function(msg) {
        const s = `----------------------------- AUDIT SHARDED UNIT TEST: ${
            msg} -----------------------------`;
        print(Array(s.length + 1).join('-'));
        print(s);
    };

    loudTestEcho(`${name} STARTING`);

    const dbpath = getDBPath();
    let st = new ShardingTest({
        name: 'auditTestSharding',
        verbose: 1,
        mongos: [
            Object.merge({
                auditPath: dbpath + '/auditLog-s0.json',
                auditDestination: 'file',
                auditFormat: 'JSON'
            },
                         serverParams),
            Object.merge({
                auditPath: dbpath + '/auditLog-s1.json',
                auditDestination: 'file',
                auditFormat: 'JSON'
            },
                         serverParams),
        ],
        shards: [
            Object.merge({
                auditPath: dbpath + '/auditLog-d0.json',
                auditDestination: 'file',
                auditFormat: 'JSON'
            },
                         mongodOptions(serverParams)),
            Object.merge({
                auditPath: dbpath + '/auditLog-d1.json',
                auditDestination: 'file',
                auditFormat: 'JSON'
            },
                         mongodOptions(serverParams))
        ],
        config: {
            configOptions: {
                auditPath: dbpath + '/auditLog-c0.json',
                auditDestination: 'file',
                auditFormat: 'JSON'
            },
        },
    });
    try {
        fn(st);
    } finally {
        st.stop();
    }
    loudTestEcho(`${name} PASSED`);
}

// Drop the existing audit events collection, import
// the audit json file, then return the new collection.
export function getAuditEventsCollection(m, dbname, primary, useAuth, loadRotated) {
    let adminDB = m.getDB('admin');
    let auth = ((useAuth !== undefined) && (useAuth != false)) ? true : false;
    if (auth) {
        assert(adminDB.auth('admin', 'admin'), "could not auth as admin (pwd admin)");
    }

    // the audit log is specifically parsable by mongoimport,
    // so we use that to conveniently read its contents.
    let auditOptions = adminDB.runCommand('auditGetOptions');
    let auditPath = auditOptions.path;
    let auditCollectionName = 'auditCollection';
    return loadAuditEventsIntoCollection(
        m, auditPath, dbname, auditCollectionName, primary, auth, loadRotated);
}

function dirname(path) {
    if (typeof path !== 'string')
        throw new TypeError('Path must be a string');

    // Remove trailing slashes
    while (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
    }

    const idx = path.lastIndexOf('/');
    // If no slash is found, return '.' (current directory)
    if (idx === -1)
        return '.';
    // If the slash is at the start, return '/' (root directory)
    if (idx === 0)
        return '/';
    // Otherwise, return the substring up to the last slash
    return path.slice(0, idx);
}

// Checks if the file path has a valid date suffix
// The suffix should be in the format 'YYYY-MM-DDTHH-MM-SS'
export function isValidDateSuffix(rotatedFileName, baseFileName) {
    if (typeof rotatedFileName !== 'string' || typeof baseFileName !== 'string') {
        throw new TypeError('Both rotatedFileName and baseFileName must be strings');
    }

    // The file name must start with the base file name followed by a dot
    if (!rotatedFileName.startsWith(baseFileName + '.')) {
        return false;
    }

    // Extract the suffix and check if it matches the expected date format
    // The expected format is 'YYYY-MM-DDTHH-MM-SS'
    const suffix = rotatedFileName.substring(baseFileName.length + 1);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(suffix)) {
        return false;
    }

    // Replace the '-' with ':' for hour to create an ISO date string
    // Example: '2023-10-01T12-30-45' becomes '2023-10-01T12:30:45'
    const isoDateString = suffix.replace(/(\d{2})-(\d{2})-(\d{2})$/, '$1:$2:$3');

    const date = new Date(isoDateString);
    return !isNaN(date.getTime());
}

// Import a JSON file into a MongoDB collection.
function importFile(filename, collection) {
    cat(filename)
        .split('\n')
        .filter(line => line.length > 0)
        .forEach(ev => collection.insert(parseJsonCanonical(ev)));
}

// Load audit log events into a named collection
export function loadAuditEventsIntoCollection(
    m, filename, dbname, collname, primary, auth, loadRotated) {
    let db = primary !== undefined ? primary.getDB(dbname) : m.getDB(dbname);

    // Make all audit events durable
    // To make "non-durable" events like auth checks or app messages durable
    // we need to put some "durable" events after them.
    // Those extra events won't affect our tests because all tests search
    // events only in strict time range  (beforeCmd, beforeLoad).
    let fooColl = db.getCollection('foo' + Date.now());
    fooColl.insert({a: 1});
    fooColl.drop();
    sleep(110);

    // drop collection
    db[collname].drop();
    // load data from audit log file
    let auditCollection = db.getCollection(collname);
    importFile(filename, auditCollection);

    // conditionally import all rotated audit log files to collection
    if (loadRotated) {
        ls(dirname(filename)).forEach(function(file) {
            if (isValidDateSuffix(file, filename)) {
                importFile(file, auditCollection);
            }
        });
    }

    // allow duplicate audit log lines with "unique: false"
    // because during some runs of audit_<something>_sharding.js tests
    // we observed "logout" records with identical timestamps
    assert.commandWorked(auditCollection.createIndex(
        {atype: 1, ts: 1, local: 1, remote: 1, users: 1, param: 1, result: 1}, {unique: false}));

    return auditCollection;
}

// Get a query that matches any timestamp generated in the interval
// of (t - n) <= t <= now for some time t.
function withinFewSecondsBefore(t, n) {
    const fewSecondsAgo = t - ((n !== undefined ? n : 3) * 1000);
    return {'$gte': new Date(fewSecondsAgo), '$lte': new Date()};
}

// Get a query that matches any timestamp generated in the interval
// of t <= x <= e for some timestamps t and e.
export function withinInterval(t, e = Date.now()) {
    return {'$gte': new Date(t), '$lte': new Date(e)};
}

// Create Admin user.  Used for authz tests.
export function createAdminUserForAudit(m) {
    let adminDB = m.getDB('admin');
    adminDB.createUser({
        'user': 'admin',
        'pwd': 'admin',
        'roles': ['readWriteAnyDatabase', 'userAdminAnyDatabase', 'clusterAdmin']
    });
}

// Creates a User with limited permissions. Used for authz tests.
export function createNoPermissionUserForAudit(m, db) {
    let passwordUserNameUnion = 'tom';
    let adminDB = m.getDB('admin');
    adminDB.auth('admin', 'admin');
    db.createUser({'user': 'tom', 'pwd': 'tom', 'roles': []});
    adminDB.logout();
    return passwordUserNameUnion;
}

// Extracts mongod options from TestData and appends them to the object
function mongodOptions(o) {
    if ('storageEngine' in TestData && TestData.storageEngine != "") {
        o.storageEngine = TestData.storageEngine;
    }
    return o;
}
