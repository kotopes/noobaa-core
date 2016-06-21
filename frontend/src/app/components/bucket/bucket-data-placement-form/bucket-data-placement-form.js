import template from './bucket-data-placement-form.html';
import ko from 'knockout';
import { tierInfo, systemInfo } from 'model';
import { loadTier } from 'actions';
import { formatSize } from 'utils';

const placementTypeMapping = Object.freeze({
    SPREAD: 'Spread',
    MIRROR: 'Mirror'
});

class BucketDataPlacementFormViewModel {
    constructor({ bucket }) {

        this.policy = ko.pureComputed(
            () => bucket() && bucket().tiering
        );

        let tierName = ko.pureComputed(
            () => this.policy() && this.policy().tiers[0].tier
        );

        this.tierSub = tierName.subscribe(
            name => loadTier(name)
        );

        this.poolCount = ko.pureComputed(
            () => tierInfo() && tierInfo().pools.length
        );

        this.placementType = ko.pureComputed(
            () => tierInfo() && placementTypeMapping[
                tierInfo().data_placement
            ]
        );

        this.pools = ko.pureComputed(
            () => tierInfo() && tierInfo().pools.map(
                name => {
                    let pool = systemInfo() && systemInfo().pools.find(
                        pool => pool.name === name
                    );

                    return {
                        name: name,
                        onlineNodeCount: pool ? pool.nodes.count : 'N/A',
                        freeSpace: pool ? formatSize(pool.storage.free) : 'N/A'
                    };
                }
            )
        );

        this.isPolicyModalVisible = ko.observable(false);

        tierName() && loadTier(tierName());
    }

    showPolicyModal() {
        this.isPolicyModalVisible(true);
    }

    hidePolicyModal() {
        this.isPolicyModalVisible(false);
    }

    dispose() {
        this.tierSub.dispose();
    }
}

export default {
    viewModel: BucketDataPlacementFormViewModel,
    template: template
};
