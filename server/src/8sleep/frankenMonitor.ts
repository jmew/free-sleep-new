import moment from 'moment-timezone';
import logger from '../logger.js';
import settingsDB from '../db/settings.js';
import { connectFranken } from './frankenServer.js';
import { wait } from './promises.js';
import { DeviceStatus, Version } from '../routes/deviceStatus/deviceStatusSchema.js';
import { Side } from '../db/schedulesSchema.js';
import { Gesture, GestureSchema } from '../db/settingsSchema.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import { DeepPartial } from 'ts-essentials';
import serverStatus from '../serverStatus.js';
import { BASE_PRESETS } from './basePresets.js';
import { trimixBase } from './trimixBaseControl.js';
import memoryDB from '../db/memoryDB.js';
import fs from 'fs';
import cbor from 'cbor';

const DEFAULT_SNOOZE_MINUTES = 10;
const MIN_SNOOZE_MINUTES = 1;
const MAX_SNOOZE_MINUTES = 10;

export class FrankenMonitor {
  private isRunning: boolean;
  private deviceStatus?: DeviceStatus;
  private currentBasePreset: keyof typeof BASE_PRESETS = 'relax';

  constructor() {
    this.isRunning = false;
    this.deviceStatus = undefined;
  }

  public async start() {
    if (this.isRunning) {
      logger.warn('FrankenMonitor is already running');
      return;
    }
    this.isRunning = true;
    this.frankenLoop().catch(error => {
      logger.error(error);
      serverStatus.status.frankenMonitor.status = 'failed';
      serverStatus.status.frankenMonitor.message = String(error);
      serverStatus.status.frankenMonitor.timestamp = moment.tz().format();
    });
  }

  public stop() {
    if (!this.isRunning) return;
    logger.debug('Stopping FrankenMonitor loop');
    this.isRunning = false;
  }

  private async snoozeAlarm(side: 'left' | 'right', minutes: number) {
    logger.info(`Snoozing alarm for ${side} for ${minutes} minutes.`);
    try {
      // Read existing alarm settings using CBOR decoding
      const alarmBytes = fs.readFileSync('/persistent/alarm.cbr');
      const alarmData = cbor.decode(alarmBytes);
      logger.debug(
        `Decoded alarm data: ${JSON.stringify(alarmData)}`,
        'alarm data',
      );

      // Access the side data
      const sideData = alarmData[side];
      if (!sideData || typeof sideData !== 'object') {
        throw new Error(`Invalid alarm data for ${side} side`);
      }

      // Validate snooze minutes
      if (
        minutes < MIN_SNOOZE_MINUTES ||
        minutes > MAX_SNOOZE_MINUTES
      ) {
        // Using a default of 10 if the value is out of range, but logging a warning.
        logger.warn(`Snooze minutes ${minutes} out of range. Defaulting to 10.`);
        minutes = 10;
      }

      // Calculate snooze time
      const snoozeTime =
        Math.floor(Date.now() / 1000) + minutes * 60;

      // Create alarm payload using existing settings
      const alarmPayload = {
        pl: sideData.pl,
        du: sideData.du,
        tt: snoozeTime,
        pi: sideData.pi,
      };

      const cborPayload = cbor.encode(alarmPayload);
      const hexPayload = cborPayload.toString('hex');
      const command =
        side === 'left'
          ? 'ALARM_LEFT'
          : 'ALARM_RIGHT';

      logger.info(
        `Setting snooze alarm for ${side} side in ${minutes} minutes with pattern ${alarmPayload.pi} (payload: ${JSON.stringify(alarmPayload)})`,
      );
      await executeFunction(command, hexPayload);
    } catch (error) {
      logger.error(
        `Failed to snooze alarm: ${error instanceof Error ? error.message : String(error)}`,
      );
      // On error, just clear the alarm
      await executeFunction('ALARM_CLEAR', 'empty');
    }
  }

  private async processGesture(side: Side, gesture: Gesture) {
    const behavior = settingsDB.data[side].taps[gesture];
    if (behavior.type === 'temperature') {
      const currentTemperatureTarget = this.deviceStatus![side].targetTemperatureF;
      let newTemperatureTargetF;
      const change = behavior.amount;
      if (behavior.change === 'increment') {
        newTemperatureTargetF = currentTemperatureTarget + change;
      } else {
        newTemperatureTargetF = currentTemperatureTarget + (-1 * change);
      }
      logger.debug(`Processing gesture temperature change for ${side}. ${currentTemperatureTarget} -> ${newTemperatureTargetF}`);
      return await updateDeviceStatus({ [side]: { targetTemperatureF: newTemperatureTargetF } } as DeepPartial<DeviceStatus>);
    } else if (behavior.type === 'alarm') {
      if (this.deviceStatus && (this.deviceStatus.left.isAlarmVibrating || this.deviceStatus.right.isAlarmVibrating)) {
        logger.info(`[tripleTap] Snoozing active alarm on ${side} side.`);
        await this.snoozeAlarm(side, 10);
      }
    } else if (behavior.type === 'base') {
      // Cycle between relax and flat presets
      this.currentBasePreset =
        this.currentBasePreset === 'relax' ? 'flat' : 'relax';

      const targetPreset = BASE_PRESETS[this.currentBasePreset];

      logger.info(
        `[quadTap] Cycling base to ${this.currentBasePreset} preset:`,
        targetPreset,
      );

      try {
        // Update memory DB to reflect movement
        if (memoryDB.data) {
          memoryDB.data.baseStatus = {
            head: targetPreset.head,
            feet: targetPreset.feet,
            isMoving: true,
            lastUpdate: new Date().toISOString(),
            isConfigured: true,
          };
          await memoryDB.write();
        }

        // Control the base via BLE
        if (this.currentBasePreset === 'flat') {
          await trimixBase.goToFlat();
        } else {
          await trimixBase.setPosition({
            head: targetPreset.head,
            feet: targetPreset.feet,
            feedRate: targetPreset.feedRate,
          });
        }

        // Estimate movement completion time
        const currentStatus = memoryDB.data?.baseStatus;
        const estimatedTime = Math.max(
          Math.abs((currentStatus?.head || 0) - targetPreset.head) * 200,
          Math.abs((currentStatus?.feet || 0) - targetPreset.feet) * 200,
          3000, // Minimum 3 seconds
        );

        setTimeout(async () => {
          logger.info(
            `[quadTap] Base ${this.currentBasePreset} preset movement completed`,
          );
          if (memoryDB.data?.baseStatus) {
            memoryDB.data.baseStatus.isMoving = false;
            await memoryDB.write();
          }
        }, estimatedTime);
      } catch (error) {
        logger.error(
          `[quadTap] Failed to set base preset: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Reset movement status on error
        if (memoryDB.data?.baseStatus) {
          memoryDB.data.baseStatus.isMoving = false;
          await memoryDB.write();
        }

        // Revert preset state on error
        this.currentBasePreset =
          this.currentBasePreset === 'relax' ? 'flat' : 'relax';
      }
    }
  }

  private processGesturesForSide(nextDeviceStatus: DeviceStatus, side: Side) {
    try {
      for (const gesture of GestureSchema.options) {
        if (nextDeviceStatus[side].taps?.[gesture] !== this?.deviceStatus?.[side].taps?.[gesture]) {
          this.processGesture(side, gesture);
        }
      }
    } catch (error) {
      logger.error(error);
    }
  }

  private async processGestures(nextDeviceStatus: DeviceStatus) {
    if (!this.deviceStatus) {
      logger.warn('Missing current deviceStatus, exiting...');
      return;
    }

    this.processGesturesForSide(nextDeviceStatus, 'left');
    this.processGesturesForSide(nextDeviceStatus, 'right');
  }


  private async frankenLoop() {
    const franken = await connectFranken();
    this.deviceStatus = await franken.getDeviceStatus(false);
    let hasGestures = this.deviceStatus.coverVersion !== Version.Pod3;
    let waitTime = hasGestures ? 2_000 : 60_000;
    if (hasGestures) {
      this.deviceStatus = await franken.getDeviceStatus(true);
      logger.debug(`Gestures supported for ${this.deviceStatus.coverVersion}`);
    } else {
      logger.debug(`Gestures not supported for ${this.deviceStatus.coverVersion}`);
    }
    // No point in querying device status every 3 seconds for checking the prime status...
    while (this.isRunning) {
      try {
        while (this.isRunning) {
          hasGestures = this.deviceStatus.coverVersion !== Version.Pod3;
          waitTime = hasGestures ? 2_000 : 60_000;
          await wait(waitTime);
          if (!this.isRunning) break;
          const franken = await connectFranken();
          const nextDeviceStatus = await franken.getDeviceStatus(hasGestures);
          await settingsDB.read();
          if (hasGestures) {
            this.processGestures(nextDeviceStatus);
          }
          this.deviceStatus = nextDeviceStatus;
          serverStatus.status.frankenMonitor.status = 'healthy';
          serverStatus.status.frankenMonitor.message = '';
          serverStatus.status.frankenMonitor.timestamp = moment.tz().format();
        }
      } catch (error) {
        serverStatus.status.frankenMonitor.status = 'failed';
        serverStatus.status.frankenMonitor.message = String(error);
        serverStatus.status.frankenMonitor.timestamp = moment.tz().format();
        logger.error(error instanceof Error ? error.message : String(error), 'franken disconnected');
        await wait(waitTime);
      }
    }
    logger.debug('FrankenMonitor loop exited');
  }
}


