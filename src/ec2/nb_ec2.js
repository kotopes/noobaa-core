"use strict";

var _ = require('lodash');
var Q = require('q');
var fs = require('fs');
var util = require('util');
var async = require('async');
var dotenv = require('dotenv');
var argv = require('minimist')(process.argv);
var AWS = require('aws-sdk');
Q.longStackSupport = true;


/**
 *
 * NB_EC2
 *
 * noobaa's ec2 wrapper
 *
 */
var nb_ec2 = {
    scale_instances: scale_instances,
    describe_instances: describe_instances,
    describe_instance: describe_instance,
    terminate_instances: terminate_instances,
    import_key_pair_to_region: import_key_pair_to_region,
};

module.exports = nb_ec2;


/* load aws config from env */

if (!process.env.AWS_ACCESS_KEY_ID) {
    console.log('loading .env file...');
    dotenv.load();
}

// AWS.config.loadFromPath('./env.js');
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: 'us-east-1',
    // region: process.env.AWS_REGION,
});

var KEY_PAIR_PARAMS = {
    KeyName: 'noobaa-demo',
    PublicKeyMaterial: fs.readFileSync(__dirname + '/noobaa-demo.pub')
};

// the run script to send to started instances
var run_script = fs.readFileSync(__dirname + '/init_agent.sh');



/**
 *
 * get_regions
 *
 */
function get_regions(func) {
    return ec2_call('describeRegions');
}


/**
 *
 * foreach_region
 *
 * @param func is function(region) that can return a promise.
 * @return promise for array of results per region func.
 *
 */
function foreach_region(func) {
    return get_regions()
        .then(function(res) {
            return Q.all(_.map(res.Regions, func));
        });
}


/**
 *
 * describe_instances
 *
 * @return instance array with entry per region,
 *      each entry is array of instance info.
 *
 */
function describe_instances(params) {
    return foreach_region(function(region) {
            return ec2_region_call(region.RegionName, 'describeInstances', params)
                .then(function(res) {
                    // return a flat array of instances from res.Reservations[].Instances[]
                    var instances = _.flatten(res.Reservations, 'Instances');
                    // prepare instance extra fields and filter out irrelevant instances
                    return _.filter(instances, function(instance) {
                        instance.region = region;
                        instance.region_name = region.RegionName;
                        instance.tags_map = _.mapValues(_.indexBy(instance.Tags, 'Key'), 'Value');
                        if (instance.tags_map.Name !== argv.tag) {
                            console.log('FILTERED', instance.InstanceId, instance.tags_map.Name);
                            return false;
                        }
                        return true;
                    });
                });
        })
        .then(function(res) {
            // flatten again for all regions
            return _.flatten(res);
        });
}



/**
 *
 * describe_instance
 *
 * @return info of single instance
 *
 */
function describe_instance(instance_id) {
    return describe_instances({
            InstanceIds: [instance_id]
        })
        .then(function(res) {
            return res[0];
        });
}



/**
 *
 * scale_instances
 *
 */
function scale_instances(count, allow_terminate) {

    return describe_instances({
        Filters: [{
            Name: 'instance-state-name',
            Values: ['running', 'pending']
        }]
    }).then(function(instances) {

        var instances_per_region = _.groupBy(instances, 'region_name');
        var region_names = _.keys(instances_per_region);

        var target_region_count = 0;
        var first_region_extra_count = 0;
        if (count < region_names.length) {
            // if number of instances is smaller than the number of regions,
            // we will add one instance per region until we have enough instances.
            if (count === 0) {
                target_region_count = 0;
            } else {
                target_region_count = 1;
            }
        } else {
            // divide instances equally per region.
            // the first region will get the redundant instances
            target_region_count = Math.floor(count / region_names.length);
            first_region_extra_count = (count % region_names.length);
            if (target_region_count > 20) {
                target_region_count = 20;
                first_region_extra_count = 0;
                console.log('Cannot scale to over 20 instances per region. will scale to 20');
            }
        }

        console.log('Scale:', target_region_count, 'per region');
        console.log('Scale:', first_region_extra_count, 'extra in first region');

        var new_count = 0;
        return Q.all(_.map(instances_per_region, function(instances, region_name) {
            var region_count = 0;
            if (new_count < count) {
                if (first_region_extra_count > 0 && region_name === region_names[0]) {
                    region_count = target_region_count + first_region_extra_count;
                } else {
                    region_count = target_region_count;
                }
                new_count += region_count;
            }

            return scale_region(region_name, region_count, instances, allow_terminate);
        }));
    });
}


/**
 *
 * scale_region
 *
 */
function scale_region(region_name, count, instances, allow_terminate) {

    // always make sure the region has the security group and key pair
    return Q
        .fcall(function() {
            return create_security_group(region_name);
        })
        .then(function() {
            return import_key_pair_to_region(region_name);
        })
        .then(function() {

            // need to create
            if (count > instances.length) {
                console.log('ScaleRegion:', region_name, 'has', instances.length,
                    ' +++ adding', count - instances.length);
                return add_region_instances(region_name, count - instances.length);
            }

            // need to terminate
            if (count < instances.length) {
                if (!allow_terminate) {
                    console.log('ScaleRegion:', region_name, 'has', instances.length,
                        ' ??? should remove', instances.length - count);
                    throw new Error('allow_terminate');
                }
                console.log('ScaleRegion:', region_name, 'has', instances.length,
                    ' --- removing', instances.length - count);
                var death_row = _.first(instances, instances.length - count);
                var ids = _.pluck(death_row, 'InstanceId');
                return terminate_instances(region_name, ids);
            }

            console.log('ScaleRegion:', region_name, 'has', instances.length, ' ... unchanged');
        });
}


/**
 *
 * add_region_instances
 *
 */
function add_region_instances(region_name, count) {
    return Q
        .fcall(get_ami_image_id, region_name)
        .then(function(ami_image_id) {
            console.log('AddInstance:', region_name, count, ami_image_id);
            return ec2_region_call(region_name, 'runInstances', {
                ImageId: ami_image_id,
                MaxCount: count,
                MinCount: count,
                // InstanceType: 'm3.large',
                InstanceType: 't2.micro',
                BlockDeviceMappings: [{
                    DeviceName: '/dev/sda1',
                    Ebs: {
                        VolumeSize: 200,
                    },
                }],
                KeyName: KEY_PAIR_PARAMS.KeyName,
                SecurityGroups: ['ssh_and_http_v2'],
                UserData: new Buffer(run_script).toString('base64'),
            });
        });
}


var _cached_ami_image_id;

/**
 *
 * get_ami_image_id
 *
 * @return the image id and save in memory for next calls
 *
 */
function get_ami_image_id(region_name) {
    // if (_cached_ami_image_id) return _cached_ami_image_id;

    return ec2_region_call(region_name, 'describeImages', {
            Filters: [{
                Name: 'name',
                Values: [
                    'ubuntu/images/hvm-ssd/ubuntu-trusty-14.04-amd64-server-20140927',
                ]
            }]
        })
        .then(function(res) {
            _cached_ami_image_id = res.Images[0].ImageId;
            return _cached_ami_image_id;
        });
}



/**
 *
 * terminate_instance
 *
 * @param instance_ids array of ids.
 */
function terminate_instances(region_name, instance_ids) {
    console.log('Terminate:', region_name, 'terminating',
        instance_ids.length, 'instances -', instance_ids);
    return ec2_region_call(region_name, 'terminateInstances', {
        InstanceIds: instance_ids,
    }).then(null, function(err) {
        if (err.code === 'InvalidInstanceID.NotFound') {
            console.error(err);
            return;
        }
        throw err;
    });
}



/**
 *
 * import_key_pair_to_region
 *
 */
function import_key_pair_to_region(region_name) {
    return ec2_region_call(region_name, 'importKeyPair', KEY_PAIR_PARAMS)
        .then(function(res) {
            console.log('KeyPair: imported', res.KeyName);
        }, function(err) {
            if (err.code === 'InvalidKeyPair.Duplicate') return;
            throw err;
        });
}



/**
 *
 * create_security_group
 *
 */
function create_security_group(region_name) {
    var ssh_and_http_v2 = 'ssh_and_http_v2';

    // first find if the group exists
    return ec2_region_call(region_name, 'describeSecurityGroups', {
            GroupNames: [ssh_and_http_v2]
        })
        .then(function(group_data) {

            // yeah! exists. return it to check if port rules exists
            // console.log('SecurityGroup: Found on region', region_name);
            return group_data;
        }, function(err) {

            // if failed because of some really bad thing then bail
            if (err.code !== 'InvalidSecurityGroup.NotFound') {
                console.error('SecurityGroup: describe failed', region_name, err);
                throw err;
            }

            // if failed because the group doesn't exists - create it.
            console.log('SecurityGroup: will create for region', region_name);
            return ec2_region_call(region_name, 'createSecurityGroup', {
                    Description: ssh_and_http_v2,
                    GroupName: ssh_and_http_v2
                })
                .then(null, function(err) {
                    console.error('SecurityGroup: create failed', region_name, err);
                    throw err;
                });
        })
        .then(function(group_data) {

            // set the port rules of the group to open ports ssh(22) and http(80)
            // console.log('SecurityGroup: setting ssh/http rules for group',
            // group_data.GroupId, region_name);
            return ec2_region_call(region_name, 'authorizeSecurityGroupIngress', {
                    GroupId: group_data.GroupId,
                    GroupName: ssh_and_http_v2,
                    IpPermissions: [{
                            FromPort: 22,
                            IpProtocol: 'tcp',
                            ToPort: 22,
                            IpRanges: [{
                                CidrIp: '0.0.0.0/0'
                            }]
                        }, {
                            FromPort: 80,
                            IpProtocol: 'tcp',
                            ToPort: 80,
                            IpRanges: [{
                                CidrIp: '0.0.0.0/0'
                            }]
                        },
                        /* more items */
                    ]
                })
                .then(function(data) {
                    console.log('SecurityGroup: Opened ports 22 and 80');
                }, function(err) {

                    // if failed because the rules exist - it's a good thing
                    if (err.code === 'InvalidPermission.Duplicate') {
                        // console.log('SecurityGroup: Rules exist for region', region_name);
                        return;
                    }
                    console.error('SecurityGroup: authorize failed',
                        region_name, group_data.GroupId, err);
                    throw err;
                });
        });
}


var _ec2 = new AWS.EC2();
var _ec2_per_region = {};

function ec2_call(func_name, params) {
    return Q.nfcall(_ec2[func_name].bind(_ec2), params);
}


function ec2_region_call(region_name, func_name, params) {
    var ec2 = _ec2_per_region[region_name] = _ec2_per_region[region_name] || new AWS.EC2({
        region: region_name
    });
    return Q.nfcall(ec2[func_name].bind(ec2), params);
}


// print object with deep levels
function console_inspect(desc, obj) {
    console.log(desc);
    console.log(util.inspect(obj, {
        depth: null
    }));
}

function print_instances(instances) {
    if (argv.long) {
        console_inspect('Instances:', instances);
    } else {
        _.each(instances, function(instance) {
            console.log('Instance:',
                instance.InstanceId,
                instance.State && instance.State.Name || '[no-state]',
                instance.PublicIpAddress,
                instance.region_name,
                instance.tags_map.Name || '[no-name]',
                '[private ip ' + instance.PrivateIpAddress + ']'
            );
        });
    }

}

/**
 *
 *
 *
 */
function main() {

    if (!_.isUndefined(argv.scale)) {

        // add a --term flag to allow removing nodes
        scale_instances(argv.scale, argv.term)
            .then(function(res) {
                console_inspect('Scale: completed to ' + argv.scale, res);
                return describe_instances().then(print_instances);
            }, function(err) {
                if (err.message === 'allow_terminate') {
                    console.error('\n\n******************************************');
                    console.error('SCALE DOWN REJECTED');
                    console.error('Use --term flag to allow terminating nodes');
                    console.error('******************************************\n\n');
                    return;
                }
                throw err;
            })
            .done();

    } else if (!_.isUndefined(argv.instance)) {

        describe_instance(argv.instance)
            .then(function(instance) {
                console_inspect('Instance ' + argv.instance + ':', instance);
            })
            .done();

    } else {

        describe_instances().then(print_instances).done();
    }
}

if (require.main === module) {
    main();
}
