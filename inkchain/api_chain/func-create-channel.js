/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
'use strict';

let inkUtils = require('../InkUtils.js');


var utils = require('inkchain-client/lib/utils.js');
var logger = utils.getLogger('inkchain create-channel');

var tape = require('tape');
var _test = require('tape-promise');
var test = _test(tape);

var Client = require('inkchain-client');
var util = require('util');
var fs = require('fs');
var path = require('path');
var grpc = require('grpc');

var _commonProto = grpc.load(path.join(inkUtils.WORK_PATH,'inkchain-client/lib/protos/common/common.proto')).common;
var _configtxProto = grpc.load(path.join(inkUtils.WORK_PATH, 'inkchain-client/lib/protos/common/configtx.proto')).common;

var testUtil = require(path.join(inkUtils.WORK_PATH,'inkchain/utils/unit/util.js'));

var the_user = null;

var ORGS;

var channel_name = inkUtils.CHANNEL_NAME;
// can use "channel=<name>" to control the channel name from command line
if (process.argv.length > 2) {
    if (process.argv[2].indexOf('channel=') === 0) {
        channel_name = process.argv[2].split('=')[1];
    }
}

//
//Attempt to send a request to the orderer with the createChannel method
//
test('\n\n***** SDK Built config update  create flow  *****\n\n', function(t) {
    testUtil.resetDefaults();
    Client.addConfigFile(path.join(inkUtils.WORK_PATH, 'inkchain/config.json'));
    ORGS = Client.getConfigSetting('test-network');

    //
    // Create and configure the test channel
    //
    var client = new Client();

    var caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(path.join(inkUtils.WORK_PATH,'inkchain', caRootsPath));
    let caroots = Buffer.from(data).toString();

    var orderer = client.newOrderer(
        ORGS.orderer.url,
        {
            'pem': caroots,
            'ssl-target-name-override': ORGS.orderer['server-hostname']
        }
    );


    var TWO_ORG_MEMBERS_AND_ADMIN = [{
        role: {
            name: 'member',
            mspId: 'Org1MSP'
        }
    }, {
        role: {
            name: 'member',
            mspId: 'Org2MSP'
        }
    }, {
        role: {
            name: 'admin',
            mspId: 'OrdererMSP'
        }
    }];

    var ONE_OF_TWO_ORG_MEMBER = {
        identities: TWO_ORG_MEMBERS_AND_ADMIN,
        policy: {
            '1-of': [{ 'signed-by': 0 }, { 'signed-by': 1 }]
        }
    };

    var ACCEPT_ALL = {
        identities: [],
        policy: {
            '0-of': []
        }
    };

    var config = null;
    var signatures = [];

    // Acting as a client in org1 when creating the channel
    var org = ORGS.org1.name;

    utils.setConfigSetting('key-value-store', 'inkchain-client/lib/impl/FileKeyValueStore.js');

    return Client.newDefaultKeyValueStore({
        path: testUtil.storePathForOrg(org)
    }).then((store) => {
        client.setStateStore(store);
        var cryptoSuite = Client.newCryptoSuite();
        cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(org)}));
        client.setCryptoSuite(cryptoSuite);

        return testUtil.getOrderAdminSubmitter(client);
    }).then((admin) =>{
        t.pass('Successfully enrolled user \'admin\' for orderer');

        // use the config update created by the configtx tool
        let envelope_bytes = fs.readFileSync(path.join(inkUtils.WORK_PATH,'inkchain', 'utils/fixtures/channel/mychannel.tx'));
        config = client.extractChannelConfig(envelope_bytes);
        t.pass('Successfull extracted the config update from the configtx envelope');

        client._userContext = null;
        return testUtil.getSubmitter(client, true /*get the org admin*/, 'org1');
    }).then((admin) => {
        t.pass('Successfully enrolled user \'admin\' for org1');

        // sign the config
        var signature = client.signChannelConfig(config);
        // convert signature to a storable string
        // inkchain-client SDK will convert back during create
        var string_signature = signature.toBuffer().toString('hex');
        t.pass('Successfully signed config update');
        // collect signature from org1 admin
        // TODO: signature counting against policies on the orderer
        // at the moment is being investigated, but it requires this
        // weird double-signature from each org admin
        signatures.push(string_signature);
        signatures.push(string_signature);

        // make sure we do not reuse the user
        client._userContext = null;
        return testUtil.getSubmitter(client, true /*get the org admin*/, 'org2');
    }).then((admin) => {
        t.pass('Successfully enrolled user \'admin\' for org2');

        // sign the config
        var signature = client.signChannelConfig(config);
        t.pass('Successfully signed config update');

        // collect signature from org2 admin
        // TODO: signature counting against policies on the orderer
        // at the moment is being investigated, but it requires this
        // weird double-signature from each org admin
        signatures.push(signature);
        signatures.push(signature);

        // make sure we do not reuse the user
        client._userContext = null;
        return testUtil.getOrderAdminSubmitter(client);
    }).then((admin) => {
        t.pass('Successfully enrolled user \'admin\' for orderer');
        the_user = admin;

        // sign the config
        var signature = client.signChannelConfig(config);
        t.pass('Successfully signed config update');

        // collect signature from orderer org admin
        // TODO: signature counting against policies on the orderer
        // at the moment is being investigated, but it requires this
        // weird double-signature from each org admin
        signatures.push(signature);
        signatures.push(signature);

        logger.debug('\n***\n done signing \n***\n');

        // build up the create request
        let tx_id = client.newTransactionID();
        var request = {
            config: config,
            signatures : signatures,
            name : channel_name,
            orderer : orderer,
            txId  : tx_id
        };

        // send create request to orderer
        return client.createChannel(request);
    })
        .then((result) => {
            logger.debug('\n***\n completed the create \n***\n');

            logger.debug(' response ::%j',result);
            t.pass('Successfully created the channel.');
            if(result.status && result.status === 'SUCCESS') {
                return inkUtils.sleep(5000);
            } else {
                t.fail('Failed to create the channel. ');
                t.end();
            }
        }, (err) => {
            t.fail('Failed to create the channel: ' + err.stack ? err.stack : err);
            t.end();
        })
        .then((nothing) => {
            t.pass('Successfully waited to make sure new channel was created.');
            t.end();
        }, (err) => {
            t.fail('Failed to sleep due to error: ' + err.stack ? err.stack : err);
            t.end();
        });
});
