'use strict';

const stateDefinition = require('./stateDefinition').stateDefinition;
const statesToSetZero = [
    'current',
    'irradiation',
    'power',
    'voltage',
    'frequency',
    'power_dc',
    'reactivepower',
    'temperature',
];

class DataController {
    /**
     * @param adapter adapter instance
     * @param [onEventCount] called with (serial, count) when the number of event log entries of an inverter changes
     */
    constructor(adapter, onEventCount) {
        this.adapter = adapter;
        this.onEventCount = onEventCount;
        // last known number of event log entries per inverter
        this.eventCounts = new Map();
        // @KI_HINWEIS: kept per instance (not module-wide) so several instances can share one process in compact mode
        // IDs of objects already created in this run
        this.createCache = new Set();
        // serials of inverters currently offline
        this.inverterOffline = new Set();
    }

    async processInverterData(inverters) {
        for (const inverter of inverters) {
            if (!this.createCache.has(inverter.serial)) {
                const deviceObj = {
                    type: 'device',
                    common: {
                        name: inverter.name,
                        desc: 'Inverter',
                        statusStates: {
                            onlineId: `${this.adapter.name}.${this.adapter.instance}.${inverter.serial}.available`,
                        },
                    },
                    native: {},
                };
                await this.adapter.extendObjectAsync(inverter.serial, deviceObj);
                this.createCache.add(inverter.serial);
            }

            // Power control
            await this.createPowerControls(inverter.serial);

            // States
            for (const [stateName, val] of Object.entries(inverter)) {
                switch (stateName) {
                    case 'AC':
                        await this.processACData(inverter.serial, val);
                        break;
                    case 'DC':
                        await this.processDCData(inverter.serial, val);
                        break;
                    case 'INV':
                        // Create and/or set values
                        for (const [invStateName, invVal] of Object.entries((val && val['0']) || {})) {
                            await this.setObjectAndState(inverter.serial, `inv_${invStateName.toLowerCase()}`, invVal);
                        }
                        break;
                    case 'radio_stats':
                        await this.ensureChannel(`${inverter.serial}.radio`, 'Radio statistics');
                        for (const [radioStateName, radioVal] of Object.entries(val || {})) {
                            await this.setObjectAndState(
                                inverter.serial,
                                `radio_${radioStateName.toLowerCase()}`,
                                radioVal,
                            );
                        }
                        break;
                    case 'events':
                        // -1: inverter does not provide an event log
                        if (typeof val === 'number' && val >= 0) {
                            await this.ensureChannel(`${inverter.serial}.events`, 'Event log');
                            await this.setObjectAndState(inverter.serial, 'events', val);
                            if (this.eventCounts.get(inverter.serial) !== val) {
                                this.eventCounts.set(inverter.serial, val);
                                if (this.onEventCount) {
                                    this.onEventCount(inverter.serial, val);
                                }
                            }
                        }
                        break;
                    default:
                        // Must states be set to zero?
                        if (stateName.toLowerCase() == 'reachable') {
                            if (val === true) {
                                this.inverterOffline.delete(inverter.serial);
                            } else if (this.adapter.config.useInvOfflineStatesToZero) {
                                await this.invOfflineStatesToZero(inverter.serial);
                            }
                        }
                        // Create and/or set values
                        await this.setObjectAndState(inverter.serial, stateName.toLowerCase(), val);
                }
            }
        }
    }

    async processDCData(serial, val) {
        // Create channel
        if (!this.createCache.has(`${serial}.dc`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'DC',
                },
                native: {},
            };

            await this.adapter.extendObjectAsync(`${serial}.dc`, deviceObj);
            this.createCache.add(`${serial}.dc`);
        }

        // DC Input x
        for (const [string, stringObj] of Object.entries(val)) {
            // Create channel
            const stringNumber = Number(string) + 1;
            if (!this.createCache.has(`${serial}.dc.input_${stringNumber}`)) {
                const deviceObj = {
                    type: 'channel',
                    common: {
                        name: `DC Input ${stringNumber}`,
                    },
                    native: {},
                };

                await this.adapter.extendObjectAsync(`${serial}.dc.input_${stringNumber}`, deviceObj);
                this.createCache.add(`${serial}.dc.input_${stringNumber}`);
            }

            // Create and/or set values
            for (const [channelStateName, channelVal] of Object.entries(stringObj)) {
                await this.setObjectAndState(serial, `dc_${channelStateName.toLowerCase()}`, channelVal, stringNumber);
            }
        }
    }

    async processACData(serial, val) {
        // Create channel
        if (!this.createCache.has(`${serial}.ac`)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'AC',
                },
                native: {},
            };

            await this.adapter.extendObjectAsync(`${serial}.ac`, deviceObj);
            this.createCache.add(`${serial}.ac`);
        }

        const channelObj = {
            type: 'channel',
            native: {},
        };

        // AC Phase x
        for (const [phase, phaseObj] of Object.entries(val)) {
            // Create channel
            const phaseNumber = Number(phase) + 1;
            if (!this.createCache.has(`${serial}.ac.phase_${phaseNumber}`)) {
                channelObj.common = {
                    name: `Phase ${phaseNumber}`,
                };

                await this.adapter.extendObjectAsync(`${serial}.ac.phase_${phaseNumber}`, channelObj);
                this.createCache.add(`${serial}.ac.phase_${phaseNumber}`);
            }

            // Create and/or set values
            for (const [phaseStateName, phaseVal] of Object.entries(phaseObj)) {
                await this.setObjectAndState(serial, `ac_${phaseStateName.toLowerCase()}`, phaseVal, phaseNumber);
            }
        }
    }

    async createPowerControls(serial) {
        const forceStatesNameList = [
            'limit_persistent_relative',
            'limit_persistent_absolute',
            'limit_nonpersistent_relative',
            'limit_nonpersistent_absolute',
            'power_on',
            'power_off',
            'restart',
        ];
        // Create channel
        const powerControlChannelId = `${serial}.power_control`;
        if (!this.createCache.has(powerControlChannelId)) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Power control',
                },
                native: {},
            };
            await this.adapter.extendObjectAsync(powerControlChannelId, deviceObj);
            this.createCache.add(powerControlChannelId);
        }

        // Create values
        for (const stateName of forceStatesNameList) {
            await this.setObjectAndState(serial, stateName.toLowerCase());
        }
    }

    async processTotalData(data) {
        // Create channel
        if (!this.createCache.has('total')) {
            const deviceObj = {
                type: 'channel',
                common: {
                    name: 'Total',
                    desc: 'Sum over all inverters',
                },
                native: {},
            };

            await this.adapter.extendObjectAsync('total', deviceObj);
            this.createCache.add('total');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            await this.setObjectAndState('total', `total_${stateName.toLowerCase()}`, val);
        }
    }

    async processDTUData(data) {
        // Create device
        if (!this.createCache.has('dtu')) {
            const deviceObj = {
                type: 'device',
                common: {
                    name: 'OpenDTU Device',
                    statusStates: {
                        onlineId: `${this.adapter.name}.${this.adapter.instance}.dtu.available`,
                    },
                },
                native: {},
            };

            await this.adapter.extendObjectAsync('dtu', deviceObj);
            this.createCache.add('dtu');
        }

        // Create and/or set values
        for (const [stateName, val] of Object.entries(data)) {
            await this.setObjectAndState('dtu', `dtu_${stateName.toLowerCase()}`, val);
        }
    }

    /**
     * Creates a channel object once per run.
     *
     * @param id channel ID
     * @param name channel name
     */
    async ensureChannel(id, name) {
        if (this.createCache.has(id)) {
            return;
        }
        await this.adapter.extendObjectAsync(id, { type: 'channel', common: { name }, native: {} });
        this.createCache.add(id);
    }

    /**
     * Writes the hints of OpenDTU (time sync, radio problem, default password) below dtu.hints.
     *
     * @param hints hints object of the websocket message
     */
    async processHints(hints) {
        // Websocket data may arrive before the first DTU status: create the device first
        await this.processDTUData({});
        await this.ensureChannel('dtu.hints', 'Hints');
        for (const [name, val] of Object.entries(hints || {})) {
            await this.setObjectAndState('dtu', `hints_${name.toLowerCase()}`, val === true);
        }
    }

    /**
     * Writes the result of /api/limit/status or /api/power/status.
     *
     * @param data response, one object per serial
     */
    async processCommandStatus(data) {
        for (const [serial, status] of Object.entries(data || {})) {
            if (!this.createCache.has(serial) || !status || typeof status !== 'object') {
                continue;
            }
            for (const key of ['limit_set_status', 'power_set_status', 'max_power']) {
                if (status[key] !== undefined) {
                    await this.setObjectAndState(serial, key, status[key]);
                }
            }
        }
    }

    /**
     * Writes the event log of an inverter.
     *
     * @param serial inverter serial
     * @param events entries of /api/eventlog/status
     */
    async processEventLog(serial, events) {
        const fmt = sec => {
            const s = Math.max(0, Number(sec) || 0);
            const pad = n => String(Math.trunc(n)).padStart(2, '0');
            return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
        };
        const list = (Array.isArray(events) ? events : []).map(e => ({
            id: e.message_id,
            message: e.message,
            start: fmt(e.start_time),
            end: fmt(e.end_time),
        }));
        await this.ensureChannel(`${serial}.events`, 'Event log');
        await this.setObjectAndState(serial, 'events_json', JSON.stringify(list));
        const last = list[list.length - 1];
        await this.setObjectAndState(serial, 'events_last', last ? `${last.start} ${last.message}` : '');
    }

    async setObjectAndState(stateID, stateName, val, count) {
        const state = stateDefinition[stateName];
        if (!state) {
            return;
        }

        const fullStateID = `${stateID}.${state.id}`.replace('%count%', count);

        let options = undefined;

        if (this.adapter.config.protectNames) {
            options = {
                preserve: {
                    common: ['name'],
                },
            };
        }

        if (!this.createCache.has(fullStateID)) {
            await this.adapter.extendObjectAsync(
                fullStateID,
                {
                    type: 'state',
                    common: this.copyAndCleanStateObj(state),
                    native: {},
                },
                options,
            );

            // Subscribe to writable states
            if (state.write == true) {
                await this.adapter.subscribeStatesAsync(fullStateID);
            }

            this.createCache.add(fullStateID);
        }

        if (val !== undefined) {
            let value = val;

            if (state.getter) {
                value = state.getter(val);
            }

            // yieldtotal Protection against incorrect zeroing when the OpenDTU restarts if the inverter is not accessible.
            if (fullStateID.endsWith('yieldtotal')) {
                if (Number(value) <= 0) {
                    return;
                }
            }

            // Are the states allowed to be set or is the inverter offline?
            for (const serial of this.inverterOffline) {
                if (fullStateID.includes(serial)) {
                    if (statesToSetZero.includes(fullStateID.split('.').at(-1) || '')) {
                        return;
                    }
                }
            }

            await this.adapter.setStateChangedAsync(fullStateID, value, true);
        }
    }
    async invOfflineStatesToZero(serial) {
        if (this.inverterOffline.has(serial)) {
            return;
        }
        // Mark first, so concurrent messages do not trigger a second run
        this.inverterOffline.add(serial);

        // Get all StateIDs
        const allStateIDs = Object.keys(await this.adapter.getAdapterObjectsAsync());

        // Get all yieldday StateIDs to set zero
        const idsSetToZero = [];
        for (const id of allStateIDs.filter(x => x.includes(`.${serial}.`))) {
            if (statesToSetZero.includes(id.split('.').at(-1) || '')) {
                idsSetToZero.push(id);
            }
        }

        // Set IDs to Zero
        await Promise.all(idsSetToZero.map(id => this.adapter.setStateChangedAsync(id, 0, true)));
    }

    copyAndCleanStateObj(state) {
        const iobState = { ...state };
        const blacklistedKeys = ['id', 'setter', 'getter', 'setattr'];
        for (const blacklistedKey of blacklistedKeys) {
            delete iobState[blacklistedKey];
        }
        return iobState;
    }
}

module.exports = {
    DataController,
};
