/* Copyright (C) 2016 NooBaa */
'use strict';

var P = require('../util/promise');
var LinkedList = require('../util/linked_list');

module.exports = Prefetch;

/**
 *
 * Prefetch
 *
 * prefetch loads and keeps items in memory.
 * once items are fetched it will prefetch more.
 *
 * options (Object):
 * - low_length: length under which we prefetch more
 * - high_length: length over which we stop prefetching
 * - expiry_ms: time after which items will be removed
 * - load - function(count) that returns list of items,
 *          it can return more or less than requested, can return a promise.
 *
 */
function Prefetch(options) {
    var self = this;
    options = options || {};
    self.low_length = options.low_length || 100;
    self.high_length = options.high_length || 200;
    self.expiry_ms = options.expiry_ms; // default is no expiry
    self.load = options.load;

    self._length = 0;
    self._groups = new LinkedList();
    self._trigger_prefetch();

    Object.defineProperty(self, 'length', {
        enumerable: true,
        get: function() {
            return self._length;
        },
        set: function(value) { /* Empty Func */ }
    });
}


/**
 *
 * fetch
 *
 * fetch items:
 * will wait for min_count items to be available.
 * will return no more than max_count items.
 *
 * @returns a promise to an array of items or single item.
 *
 */
Prefetch.prototype.fetch = function(min_count, max_count) {
    var items = [];
    min_count = min_count || 1;
    max_count = max_count || min_count;
    return P.resolve(this._fetch(items, min_count, max_count))
        .then(function() {
            return items.length > 1 ? items : items[0];
        });
};


/**
 *
 * _fetch
 *
 * add items to the provided array, and wait for prefetch if needed.
 *
 */
Prefetch.prototype._fetch = function(items, min_count, max_count) {
    this._pop_items(items, max_count);
    // while min_count is not available call prefetch and repeat
    if (items.length < min_count) {
        return P.resolve(this._prefetch())
            .then(this._fetch.bind(this, items, min_count, max_count));
    }
};


/**
 *
 * _pop_items
 *
 * pop prefetched items and add to the provided items array
 * uses existing items only, without prefetching more,
 * so may return with less item than target.
 *
 * @param items - array of items to push to
 * @param target_length - stop when items array reaches this length
 */
Prefetch.prototype._pop_items = function(items, target_length) {
    var group = this._groups.get_front();
    if (!group) return;

    while (items.length < target_length) {

        items.push(group.items.pop());
        this._length -= 1;

        if (!group.items.length) {
            this._remove_group(group);
            group = this._groups.get_front();
            if (!group) return;
        }
    }

    this._trigger_prefetch();
};


/**
 *
 * _remove_group
 *
 */
Prefetch.prototype._remove_group = function(group) {
    clearTimeout(group.timeout);
    group.timeout = null;
    this._length -= group.items.length;
    this._groups.remove(group);
};


/**
 *
 * _expire_group
 *
 */
Prefetch.prototype._expire_group = function(group) {
    this._remove_group(group);
    this._trigger_prefetch();
};


/**
 *
 * _trigger_prefetch
 *
 */
Prefetch.prototype._trigger_prefetch = function() {
    if (this._length < this.low_length) {
        return this._prefetch();
    }
};


/**
 *
 * _prefetch
 *
 * @returns a promise to an array of items.
 *
 */
Prefetch.prototype._prefetch = function() {
    var self = this;

    if (!self._prefetch_promise) {
        self._prefetch_promise = P.fcall(function() {
                return self.load(self.high_length - self._length);
            })
            .then(function(items) {

                // keep loaded items as a group
                // in order to use array.pop() instead of array.shift()
                // we reverse the returned order of items.
                var group = {
                    items: items.slice().reverse()
                };
                if (self.expiry_ms) {
                    group.timeout = setTimeout(
                        self._remove_group.bind(self, group), self.expiry_ms);
                }
                self._length += items.length;
                self._groups.push_back(group);

                // keep triggering if needed
                // we don't return the promise from here in order for
                // fetch() to try popping asap and release the caller
                // (need to nullify promise before recursion)
                self._prefetch_promise = null;
                self._trigger_prefetch();

            }, function(err) {
                console.error('PREFETCH ERROR', err);
                // keep triggering if needed
                self._prefetch_promise = null;
                self._trigger_prefetch();
            });
    }

    return self._prefetch_promise;
};
