/* Copyright (C) 2016 NooBaa */
'use strict';

function delete_container(req, res) {
    return req.object_sdk.delete_bucket({ name: req.params.bucket })
        .then(() => {
            res.statusCode = 202;
        });
}

module.exports = {
    handler: delete_container,
    body: {
        type: 'empty',
    },
    reply: {
        type: 'empty',
    },
};
