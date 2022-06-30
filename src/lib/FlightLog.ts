import {
  FIRMWARE_TYPE_BETAFLIGHT,
  FIRMWARE_TYPE_CLEANFLIGHT,
} from "./configs/FirmwareTypes";
import {
  AXIS,
  DSHOT_MIN_VALUE,
  DSHOT_RANGE,
  FAST_PROTOCOL,
  FlightLogEvent,
  MAX_MOTOR_NUMBER,
} from "./FlightLogFieldDefs";
import {
  binarySearchOrNext,
  binarySearchOrPrevious,
  constrain,
  firmwareGreaterOrEqual,
  firstIndexLargerThanTime,
  semverGte,
} from "./utils/Utils";
import { FlightLogIndex } from "./FlightLogIndex";
import {
  FlightLogParser,
  FLIGHT_LOG_FIELD_INDEX_TIME,
} from "./FlightLogParser";
import { FlightLogFieldPresenter } from "./FieldsPresenter";
import { GraphConfig } from "./GraphConfig";

const axes = [0, 1, 2];
const ADDITIONAL_COMPUTED_FIELD_COUNT = 20; /** PID_SUM + PID_ERROR + RCCOMMAND_SCALED + MOTOR_LEGACY **/

/*
 * An index is computed to allow efficient seeking.
 *
 * Multiple disparate frame types in the original log are aligned and merged together to provide one time series.
 * Additional computed fields are derived from the original data set and added as new fields in the resulting data.
 * Window based smoothing of fields is offered.
 */
export class FlightLog {
  logIndex = 0;
  logIndexes: FlightLogIndex;
  parser: FlightLogParser;

  iframeDirectory;

  // We cache these details so they don't have to be recomputed on every request:
  numCells = 0;
  numMotors = 0;

  fieldNames = [];
  fieldNameToIndex: any = {};

  fieldPresenter = FlightLogFieldPresenter;

  constructor(logData) {
    this.logIndexes = new FlightLogIndex(logData);
    this.parser = new FlightLogParser(logData);
  }

  getMainFieldCount() {
    return this.fieldNames.length;
  }

  getMainFieldNames() {
    return this.fieldNames;
  }

  /**
   * Get the fatal parse error encountered when reading the log with the given
   * index, or false if no error was encountered.
   */
  getLogError(logIndex) {
    return this.logIndexes.getIntraframeDirectory(logIndex).error;
  }

  /**
   * Get the stats for the log of the given index, or leave off the logIndex
   * argument to fetch the stats for the current log.
   */
  _getRawStats(logIndex = null) {
    if (logIndex == null) {
      return this.iframeDirectory.stats;
    }

    return this.logIndexes.getIntraframeDirectory(logIndex).stats;
  }

  /**
   * Get the stats for the log of the given index, or leave off the logIndex
   * argument to fetch the stats for the current log.
   *
   * Stats are modified to add a global field[] array which contains merged
   * field stats for the different frame types that the flightlog presents as
   * one merged frame.
   */
  getStats(logIndex) {
    const rawStats = this._getRawStats(logIndex);

    // Just modify the raw stats variable to add this field, the parser won't
    // mind the extra field appearing:
    if (rawStats.frame.S) {
      rawStats.field = rawStats.frame.I.field.concat(rawStats.frame.S.field);
    } else {
      rawStats.field = rawStats.frame.I.field;
    }

    return rawStats;
  }

  _getTimeStats(logIndex) {
    return this._getRawStats(logIndex).frame["I"].field[
      FLIGHT_LOG_FIELD_INDEX_TIME
    ];
  }

  /**
   * Get the earliest time seen in the log of the given index (in microseconds),
   * or leave off the logIndex argument to fetch details for the current log.
   */
  getMinTime(logIndex = null) {
    return this._getTimeStats(logIndex).min;
  }

  /**
   * Get the latest time seen in the log of the given index (in microseconds),
   * or leave off the logIndex argument to fetch details for the current log.
   */
  getMaxTime(logIndex = null) {
    return this._getTimeStats(logIndex).max;
  }

  /**
   * Get the flight controller system information that was parsed for the
   * current log file.
   */
  getSysConfig() {
    return this.parser.sysConfig;
  }

  getLogCount() {
    return this.logIndexes.getLogCount();
  }

  /**
   * Return a coarse summary of throttle position and events across the entire
   * log.
   */
  getActivitySummary() {
    const directory = this.logIndexes.getIntraframeDirectory(this.logIndex);

    return {
      times: directory.times,
      avgThrottle: directory.avgThrottle,
      hasEvent: directory.hasEvent,
    };
  }

  /**
   * Get the index of the field with the given name, or undefined if that field
   * doesn't exist in the log.
   */
  getMainFieldIndexByName(name) {
    return this.fieldNameToIndex[name];
  }

  getMainFieldIndexes() {
    return this.fieldNameToIndex;
  }

  getSmoothedFrameAtTime(startTime) {
    return this.getFrameAtTime(startTime)?.current;
  }

  getFrameAtTime(startTime) {
    const chunks = this.getSmoothedChunksInTimeRange(startTime, startTime),
      chunk = chunks[0];

    if (!chunk) return;

    const i = firstIndexLargerThanTime(chunk.frames, startTime);

    return {
      previous: i >= 2 ? chunk.frames[i - 2] : null,
      current: i >= 1 ? chunk.frames[i - 1] : null,
      next: chunk.frames[i],
    };
  }

  _buildFieldNames() {
    // Make an independent copy
    this.fieldNames = this.parser.frameDefs.I.name.slice(0);

    // Add names of slow fields which we'll merge into the main stream
    if (this.parser.frameDefs.S) {
      for (let i = 0; i < this.parser.frameDefs.S.name.length; i++) {
        this.fieldNames.push(this.parser.frameDefs.S.name[i]);
      }
    }

    // Add names for our ADDITIONAL_COMPUTED_FIELDS
    if (!this.isFieldDisabled().PID) {
      this.fieldNames.push(...axes.map((axis) => `axisSum[${axis}]`));
    }
    if (!this.isFieldDisabled().SETPOINT) {
      this.fieldNames.push(
        ...[0, 1, 2, 3].map((axis) => `rcCommands[${axis}]`)
      );
    }
    if (!(this.isFieldDisabled().GYRO || this.isFieldDisabled().PID)) {
      this.fieldNames.push(...axes.map((axis) => `axisError[${axis}]`));
    }
    if (!this.isFieldDisabled().MOTORS) {
      for (let i = 0; i < MAX_MOTOR_NUMBER; i++) {
        if (this.fieldNames.find((element) => element === `motor[${i}]`)) {
          this.fieldNames.push(`motorLegacy[${i}]`);
        } else {
          break;
        }
      }
    }

    this.fieldNameToIndex = {};
    for (let i = 0; i < this.fieldNames.length; i++) {
      this.fieldNameToIndex[this.fieldNames[i]] = i;
    }
  }

  _estimateNumMotors() {
    let count = 0;

    for (let j = 0; j < MAX_MOTOR_NUMBER; j++) {
      if (this.getMainFieldIndexByName(`motor[${j}]`) !== undefined) {
        count++;
      }
    }

    this.numMotors = count;
  }

  _estimateNumCells() {
    const sysConfig = this.getSysConfig();

    //Are we even logging VBAT?
    if (!this.fieldNameToIndex.vbatLatest) {
      this.numCells = 0;
      return;
    }

    let refVoltage;
    if (firmwareGreaterOrEqual(sysConfig, "3.1.0", "2.0.0")) {
      refVoltage = sysConfig.vbatref;
    } else {
      refVoltage = this.vbatADCToMillivolts(sysConfig.vbatref) / 100;
    }

    for (
      var i = 1;
      i < 8 && refVoltage >= i * sysConfig.vbatmaxcellvoltage;
      i++
    ) {}

    this.numCells = i;
  }

  getNumCellsEstimate() {
    return this.numCells;
  }

  getNumMotors() {
    return this.numMotors;
  }

  private _allChunks = null;
  private _eventNeedsTimestamp = [];

  get allChunks() {
    if (!this._allChunks) {
      const allChunks = [];

      for (
        let chunkIndex = 0;
        chunkIndex < this.iframeDirectory.offsets.length;
        chunkIndex++
      ) {
        const chunk = this._getChunk(chunkIndex);
        allChunks.push(chunk);
      }

      this._injectComputedFields(allChunks, allChunks);

      this._allChunks = allChunks;
      this._addMissingEventTimes(this._allChunks);
    }

    return this._allChunks;
  }

  /**
   * Get the raw chunks in the range [startIndex...endIndex] (inclusive)
   *
   * When the cache misses, this will result in parsing the original log file
   * to create chunks.
   */
  _getChunksInIndexRange(startIndex, endIndex) {
    startIndex = Math.max(0, startIndex);
    endIndex = Math.min(this.iframeDirectory.offsets.length, endIndex);

    if (endIndex < startIndex) return [];

    // Make sure it's inclusive.
    return this.allChunks.slice(startIndex, endIndex + 1);
  }

  _getChunk(chunkIndex) {
    // Parse the log file to create this chunk since it wasn't cached
    const chunkStartOffset = this.iframeDirectory.offsets[chunkIndex];

    let chunkEndOffset;
    if (chunkIndex + 1 < this.iframeDirectory.offsets.length) {
      chunkEndOffset = this.iframeDirectory.offsets[chunkIndex + 1];
    } else {
      // We're at the end so parse till end-of-log
      chunkEndOffset = this.logIndexes.getLogBeginOffset(this.logIndex + 1);
    }

    const chunk: any = {
      index: chunkIndex,
      frames: [],
      gapStartsHere: {},
      events: [],
    };

    const slowFrameLength = this.parser.frameDefs.S
      ? this.parser.frameDefs.S.count
      : 0;
    const lastSlow = this.parser.frameDefs.S
      ? this.iframeDirectory.initialSlow[chunkIndex].slice(0)
      : [];

    let mainFrameIndex = 0;
    this.parser.onFrameReady = (frameValid, frame, frameType, _, __) => {
      // The G frames need to be processed always. They are "invalid" if
      // not H (Home) has been detected before, but if not processed the
      // viewer shows cuts and gaps. This happens if the quad takes off
      // before fixing enough satellites.
      if (!frameValid && frameType != "G") {
        chunk.gapStartsHere[mainFrameIndex - 1] = true;
        return;
      }
      switch (frameType) {
        case "P":
        case "I":
          const numOutputFields =
            frame.length + slowFrameLength + ADDITIONAL_COMPUTED_FIELD_COUNT;

          // Otherwise allocate a new array
          const destFrame = new Array(numOutputFields);
          chunk.frames.push(destFrame);

          // The parser re-uses the "frame" array so we must copy that
          // data somewhere else.
          for (var i = 0; i < frame.length; i++) {
            destFrame[i] = frame[i];
          }

          // Then merge in the last seen slow-frame data
          for (var i = 0; i < slowFrameLength; i++) {
            // NOTE: DON'T CHANGE THIS TO just lastSlow[i].
            destFrame[i + frame.length] =
              lastSlow[i] === undefined ? null : lastSlow[i];
          }

          mainFrameIndex++;
          break;

        case "E":
          // An object, not frame, see [parser.parseEventFrame], a new one
          // got allocated each time.
          const destEventFrame = frame;

          if (destEventFrame.event == FlightLogEvent.LOGGING_RESUME) {
            chunk.gapStartsHere[mainFrameIndex - 1] = true;
          }

          /*
           * If the event was logged during a loop iteration, it will
           * appear in the log before that loop iteration does (since the
           * main log stream is logged at the very end of the loop).
           *
           * So we want to use the timestamp of that later frame as the
           * timestamp of the loop iteration this event was logged in.
           */
          if (!destEventFrame.time) {
            this._eventNeedsTimestamp.push({
              chunkIndex: chunk.index,
              event: destEventFrame,
            });
          }

          chunk.events.push(destEventFrame);
          break;

        case "S":
          for (var i = 0; i < frame.length; i++) {
            lastSlow[i] = frame[i];
          }
          break;
      }
    };

    this.parser.resetDataState();

    this.parser.parseLogData(chunkStartOffset, chunkEndOffset);

    return chunk;
  }

  /**
   * Get an array of chunks which span times from the given start to end time.
   * Each chunk is an array of log frames.
   */
  getChunksInTimeRange(startTime, endTime) {
    const startIndex = binarySearchOrPrevious(
      this.iframeDirectory.times,
      startTime
    );
    const endIndex = binarySearchOrPrevious(
      this.iframeDirectory.times,
      endTime
    );

    return this._getChunksInIndexRange(startIndex, endIndex);
  }

  /**
   * Use the data in sourceChunks to compute additional fields.
   * and add those into the resultChunks.
   * sourceChunks and destChunks can be the same array.
   */
  _injectComputedFields(sourceChunks, destChunks) {
    let gyroADC = axes.map((axis) => this.fieldNameToIndex[`gyroADC[${axis}]`]);

    let rcCommand = [0, 1, 2, 3].map(
      (axis) => this.fieldNameToIndex[`rcCommand[${axis}]`]
    );
    let setpoint = [0, 1, 2, 3].map(
      (axis) => this.fieldNameToIndex[`setpoint[${axis}]`]
    );

    let axisPID = [
      ["axisP[0]", "axisI[0]", "axisD[0]", "axisF[0]"],
      ["axisP[1]", "axisI[1]", "axisD[1]", "axisF[1]"],
      ["axisP[2]", "axisI[2]", "axisD[2]", "axisF[2]"],
    ].map((fieldNames) =>
      fieldNames.map((fieldName) => this.fieldNameToIndex[fieldName])
    );

    let motor = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (axis) => this.fieldNameToIndex[`motor[${axis}]`]
    );

    let sourceChunkIndex;
    let destChunkIndex;

    const sysConfig = this.getSysConfig();

    if (destChunks.length === 0) {
      return;
    }

    if (!gyroADC[0]) {
      gyroADC = null;
    }

    if (!rcCommand[0]) {
      rcCommand = null;
    }

    if (!setpoint[0]) {
      setpoint = null;
    }

    if (!axisPID[0]) {
      axisPID = null;
    }

    if (!motor[0]) {
      motor = null;
    }

    sourceChunkIndex = 0;
    destChunkIndex = 0;

    // TODO: This is weird since sourceChunks and destChunks are always the
    // same.
    // Skip leading source chunks that don't appear in the destination.
    while (
      sourceChunks[sourceChunkIndex].index < destChunks[destChunkIndex].index
    ) {
      sourceChunkIndex++;
    }

    for (
      ;
      destChunkIndex < destChunks.length;
      sourceChunkIndex++, destChunkIndex++
    ) {
      const destChunk = destChunks[destChunkIndex],
        sourceChunk = sourceChunks[sourceChunkIndex];

      if (destChunk.hasAdditionalFields) continue;

      destChunk.hasAdditionalFields = true;

      for (let i = 0; i < sourceChunk.frames.length; i++) {
        this._injectComputedFieldsToFrame(
          sourceChunk,
          i,
          destChunk,
          gyroADC,
          sysConfig,
          axisPID,
          setpoint,
          rcCommand,
          motor
        );
      }
    }
  }

  private _injectComputedFieldsToFrame(
    sourceChunk: any,
    i: number,
    destChunk: any,
    gyroADC: any[],
    sysConfig: any,
    axisPID: any[][],
    setpoint: any[],
    rcCommand: any[],
    motor: any[]
  ) {
    const srcFrame = sourceChunk.frames[i],
      destFrame = destChunk.frames[i];
    let fieldIndex = destFrame.length - ADDITIONAL_COMPUTED_FIELD_COUNT;

    // Add the Feedforward PID sum (P+I+D+F).
    if (axisPID) {
      for (let axis = 0; axis < 3; axis++) {
        let pidSum =
          (axisPID[axis][0] !== undefined ? srcFrame[axisPID[axis][0]] : 0) +
          (axisPID[axis][1] !== undefined ? srcFrame[axisPID[axis][1]] : 0) +
          (axisPID[axis][2] !== undefined ? srcFrame[axisPID[axis][2]] : 0) +
          (axisPID[axis][3] !== undefined ? srcFrame[axisPID[axis][3]] : 0);

        // Limit the PID sum by the limits defined in the header
        let pidLimit =
          axis < AXIS.YAW ? sysConfig.pidSumLimit : sysConfig.pidSumLimitYaw;

        if (pidLimit != null && pidLimit > 0) {
          pidSum = constrain(pidSum, -pidLimit, pidLimit);
        }

        // Assign value
        destFrame[fieldIndex++] = pidSum;
      }
    }

    // Calculate the Scaled rcCommand (setpoint) (in deg/s, % for throttle)
    const fieldIndexRcCommands = fieldIndex;

    // Since version 4.0 is not more a virtual field. Copy the real field to
    // the virtual one to maintain the name, workspaces, etc.
    if (
      sysConfig.firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
      semverGte(sysConfig.firmwareVersion, "4.0.0")
    ) {
      // Roll, pitch and yaw
      for (var axis = 0; axis <= AXIS.YAW; axis++) {
        destFrame[fieldIndex++] = srcFrame[setpoint[axis]];
      }
      // Throttle
      destFrame[fieldIndex++] = srcFrame[setpoint[AXIS.YAW + 1]] / 10;
    } else {
      // Versions earlier to 4.0 we must calculate the expected setpoint
      // Roll, pitch and yaw
      for (let axis = 0; axis <= AXIS.YAW; axis++) {
        destFrame[fieldIndex++] =
          rcCommand[axis] !== undefined
            ? this.rcCommandRawToDegreesPerSecond(
                srcFrame[rcCommand[axis]],
                axis
              )
            : 0;
      }
      // Throttle
      destFrame[fieldIndex++] =
        rcCommand[AXIS.YAW + 1] !== undefined
          ? this.rcCommandRawToThrottle(srcFrame[rcCommand[AXIS.YAW + 1]])
          : 0;
    }

    // Calculate the PID Error
    if (axisPID && gyroADC) {
      for (let axis = 0; axis < 3; axis++) {
        let gyroADCdegrees =
          gyroADC[axis] !== undefined
            ? this.gyroRawToDegreesPerSecond(srcFrame[gyroADC[axis]])
            : 0;
        destFrame[fieldIndex++] =
          destFrame[fieldIndexRcCommands + axis] - gyroADCdegrees;
      }
    }

    // Duplicate the motor field to show the motor legacy values
    if (motor) {
      for (let motorNumber = 0; motorNumber < this.numMotors; motorNumber++) {
        destFrame[fieldIndex++] = srcFrame[motor[motorNumber]];
      }
    }

    // Remove empty fields at the end
    destFrame.splice(fieldIndex);
  }

  /**
   * Add timestamps to events that getChunksInRange was unable to compute,
   * because at the time it had trailing events in its chunk array but no
   * next-chunk to take the times from for those events.
   */
  _addMissingEventTimes(chunks) {
    for (const { chunkIndex, event } of this._eventNeedsTimestamp) {
      let nextTime;
      // Start time of the next chunk if exists.
      if (chunkIndex + 1 < chunks.length) {
        const nextChunk = chunks[chunkIndex + 1];
        nextTime = nextChunk.frames[0][FLIGHT_LOG_FIELD_INDEX_TIME];
      } else {
        const finalChunk = chunks[chunks.length - 1];
        // Otherwise we're at the end of the log so assume this event was
        // logged sometime after the final frame
        nextTime =
          finalChunk.frames[finalChunk.frames.length - 1][
            FLIGHT_LOG_FIELD_INDEX_TIME
          ];
      }

      event.time = nextTime;
    }

    this._eventNeedsTimestamp = [];
  }

  /**
   * Get an array of chunk data with event frames. NOT smoothed anymore.
   */
  getSmoothedChunksInTimeRange(startTime, endTime) {
    let startIndex = binarySearchOrPrevious(
        this.iframeDirectory.times,
        startTime
      ),
      endIndex = binarySearchOrNext(this.iframeDirectory.times, endTime);

    return this._getChunksInIndexRange(startIndex, endIndex);
  }

  /**
   * Attempt to open the log with the given index, returning true on success.
   */
  openLog(index) {
    if (this.getLogError(index)) {
      return false;
    }

    this.logIndex = index;

    this.iframeDirectory = this.logIndexes.getIntraframeDirectory(index);

    this.parser.parseHeader(
      this.logIndexes.getLogBeginOffset(index),
      this.logIndexes.getLogBeginOffset(index + 1)
    );

    // Clean the cache.
    this._allChunks = null;

    this._buildFieldNames();

    this._estimateNumMotors();
    this._estimateNumCells();

    return true;
  }

  accRawToGs(value) {
    return value / this.getSysConfig().acc_1G;
  }

  gyroRawToDegreesPerSecond(value) {
    return (
      ((this.getSysConfig().gyroScale * 1000000) / (Math.PI / 180.0)) * value
    );
  }

  /***
    The rcCommandToDegreesPerSecond function is betaflight version specific
    due to the coding improvements from v2.8.0 onwards

    @deprecated only used before 4.0.
  **/

  // Convert rcCommand to degrees per second.
  private rcCommandRawToDegreesPerSecond(value, axis) {
    const sysConfig = this.getSysConfig();

    if (firmwareGreaterOrEqual(sysConfig, "3.0.0", "2.0.0")) {
      const RC_RATE_INCREMENTAL = 14.54;
      const RC_EXPO_POWER = 3;

      const calculateSetpointRate = function (axis, rc) {
        let rcCommandf = rc / 500.0;
        let rcCommandfAbs = Math.abs(rcCommandf);

        if (sysConfig["rc_expo"][axis]) {
          const expof = sysConfig["rc_expo"][axis] / 100;
          rcCommandf =
            rcCommandf * Math.pow(rcCommandfAbs, RC_EXPO_POWER) * expof +
            rcCommandf * (1 - expof);
        }

        let rcRate = sysConfig["rc_rates"][axis] / 100.0;
        if (rcRate > 2.0) {
          rcRate += RC_RATE_INCREMENTAL * (rcRate - 2.0);
        }

        let angleRate = 200.0 * rcRate * rcCommandf;
        if (sysConfig.rates[axis]) {
          var rcSuperfactor =
            1.0 /
            constrain(
              1.0 - rcCommandfAbs * (sysConfig.rates[axis] / 100.0),
              0.01,
              1.0
            );
          angleRate *= rcSuperfactor;
        }

        const limit = sysConfig["rate_limits"][axis];
        if (sysConfig.pidController == 0 || limit == null) {
          /* LEGACY */
          return constrain(angleRate * 4.1, -8190.0, 8190.0) >> 2; // Rate limit protection
        } else {
          return constrain(angleRate, -1.0 * limit, limit); // Rate limit protection (deg/sec)
        }
      };

      return calculateSetpointRate(axis, value);
    }

    return 0;
  }

  rcCommandRawToThrottle(value) {
    // Throttle displayed as percentage.
    value =
      ((value - this.getSysConfig().minthrottle) /
        (this.getSysConfig().maxthrottle - this.getSysConfig().minthrottle)) *
      100.0;

    return Math.min(Math.max(value, 0.0), 100.0);
  }

  rcMotorRawToPctEffective(value) {
    // Motor displayed as percentage
    value =
      ((value - this.getSysConfig().motorOutput[0]) /
        (this.getSysConfig().motorOutput[1] -
          this.getSysConfig().motorOutput[0])) *
      100.0;

    return Math.min(Math.max(value, 0.0), 100.0);
  }

  rcMotorRawToPctPhysical(value) {
    // Motor displayed as percentage
    let motorPct;
    if (this.isDigitalProtocol()) {
      motorPct = ((value - DSHOT_MIN_VALUE) / DSHOT_RANGE) * 100;
    } else {
      const MAX_ANALOG_VALUE = this.getSysConfig().maxthrottle;
      const MIN_ANALOG_VALUE = this.getSysConfig().minthrottle;
      const ANALOG_RANGE = MAX_ANALOG_VALUE - MIN_ANALOG_VALUE;
      motorPct = ((value - MIN_ANALOG_VALUE) / ANALOG_RANGE) * 100;
    }
    return Math.min(Math.max(motorPct, 0.0), 100.0);
  }

  isDigitalProtocol() {
    switch (FAST_PROTOCOL[this.getSysConfig().fast_pwm_protocol]) {
      case "PWM":
      case "ONESHOT125":
      case "ONESHOT42":
      case "MULTISHOT":
      case "BRUSHED":
        return false;
      case "DSHOT150":
      case "DSHOT300":
      case "DSHOT600":
      case "DSHOT1200":
      case "PROSHOT1000":
      default:
        return true;
    }
  }

  getDefaultCurveForField(fieldName) {
    return GraphConfig.getDefaultCurveForField(this, fieldName);
  }

  getDefaultSmoothingForField(fieldName) {
    return GraphConfig.getDefaultSmoothingForField(this, fieldName);
  }

  getPIDPercentage(value) {
    // PID components and outputs are displayed as percentage
    // (raw value is 0 - 1000).
    return value / 10.0;
  }

  getReferenceVoltageMillivolts() {
    if (
      this.getSysConfig().firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
      semverGte(this.getSysConfig().firmwareVersion, "4.0.0")
    ) {
      return this.getSysConfig().vbatref * 10;
    } else if (
      (this.getSysConfig().firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
        semverGte(this.getSysConfig().firmwareVersion, "3.1.0")) ||
      (this.getSysConfig().firmwareType == FIRMWARE_TYPE_CLEANFLIGHT &&
        semverGte(this.getSysConfig().firmwareVersion, "2.0.0"))
    ) {
      return this.getSysConfig().vbatref * 100;
    } else {
      return this.vbatADCToMillivolts(this.getSysConfig().vbatref);
    }
  }

  vbatADCToMillivolts(vbatADC) {
    const ADCVREF = 33;

    // ADC is 12 bit (i.e. max 0xFFF), voltage reference is 3.3V, vbatscale is
    // premultiplied by 100
    return (vbatADC * ADCVREF * 10 * this.getSysConfig().vbatscale) / 0xfff;
  }

  amperageADCToMillivolts(amperageADC) {
    var ADCVREF = 33,
      millivolts = (amperageADC * ADCVREF * 100) / 4095;

    millivolts -= this.getSysConfig().currentMeterOffset;

    return (millivolts * 10000) / this.getSysConfig().currentMeterScale;
  }

  getFlightMode(currentFlightMode) {
    return {
      Arm: (currentFlightMode & (1 << 0)) != 0,
      Angle: (currentFlightMode & (1 << 1)) != 0,
      Horizon: (currentFlightMode & (1 << 2)) != 0,
      Baro: (currentFlightMode & (1 << 3)) != 0,
      AntiGravity: (currentFlightMode & (1 << 4)) != 0,
      Headfree: (currentFlightMode & (1 << 5)) != 0,
      HeadAdj: (currentFlightMode & (1 << 6)) != 0,
      CamStab: (currentFlightMode & (1 << 7)) != 0,
      CamTrig: (currentFlightMode & (1 << 8)) != 0,
      GPSHome: (currentFlightMode & (1 << 9)) != 0,
      GPSHold: (currentFlightMode & (1 << 10)) != 0,
      Passthrough: (currentFlightMode & (1 << 11)) != 0,
      Beeper: (currentFlightMode & (1 << 12)) != 0,
      LEDMax: (currentFlightMode & (1 << 13)) != 0,
      LEDLow: (currentFlightMode & (1 << 14)) != 0,
      LLights: (currentFlightMode & (1 << 15)) != 0,
      Calib: (currentFlightMode & (1 << 16)) != 0,
      GOV: (currentFlightMode & (1 << 17)) != 0,
      OSD: (currentFlightMode & (1 << 18)) != 0,
      Telemetry: (currentFlightMode & (1 << 19)) != 0,
      GTune: (currentFlightMode & (1 << 20)) != 0,
      Sonar: (currentFlightMode & (1 << 21)) != 0,
      Servo1: (currentFlightMode & (1 << 22)) != 0,
      Servo2: (currentFlightMode & (1 << 23)) != 0,
      Servo3: (currentFlightMode & (1 << 24)) != 0,
      Blackbox: (currentFlightMode & (1 << 25)) != 0,
      Failsafe: (currentFlightMode & (1 << 26)) != 0,
      Airmode: (currentFlightMode & (1 << 27)) != 0,
      SuperExpo: (currentFlightMode & (1 << 28)) != 0,
      _3DDisableSwitch: (currentFlightMode & (1 << 29)) != 0,
      CheckboxItemCount: (currentFlightMode & (1 << 30)) != 0,
    };
  }

  getFeatures(enabledFeatures) {
    return {
      RX_PPM: (enabledFeatures & (1 << 0)) != 0,
      VBAT: (enabledFeatures & (1 << 1)) != 0,
      INFLIGHT_ACC_CAL: (enabledFeatures & (1 << 2)) != 0,
      RX_SERIAL: (enabledFeatures & (1 << 3)) != 0,
      MOTOR_STOP: (enabledFeatures & (1 << 4)) != 0,
      SERVO_TILT: (enabledFeatures & (1 << 5)) != 0,
      SOFTSERIAL: (enabledFeatures & (1 << 6)) != 0,
      GPS: (enabledFeatures & (1 << 7)) != 0,
      FAILSAFE: (enabledFeatures & (1 << 8)) != 0,
      SONAR: (enabledFeatures & (1 << 9)) != 0,
      TELEMETRY: (enabledFeatures & (1 << 10)) != 0,
      CURRENT_METER: (enabledFeatures & (1 << 11)) != 0,
      _3D: (enabledFeatures & (1 << 12)) != 0,
      RX_PARALLEL_PWM: (enabledFeatures & (1 << 13)) != 0,
      RX_MSP: (enabledFeatures & (1 << 14)) != 0,
      RSSI_ADC: (enabledFeatures & (1 << 15)) != 0,
      LED_STRIP: (enabledFeatures & (1 << 16)) != 0,
      DISPLAY: (enabledFeatures & (1 << 17)) != 0,
      ONESHOT125: (enabledFeatures & (1 << 18)) != 0,
      BLACKBOX: (enabledFeatures & (1 << 19)) != 0,
      CHANNEL_FORWARDING: (enabledFeatures & (1 << 20)) != 0,
      TRANSPONDER: (enabledFeatures & (1 << 21)) != 0,
      AIRMODE: (enabledFeatures & (1 << 22)) != 0,
      SUPEREXPO_RATES: (enabledFeatures & (1 << 23)) != 0,
      ANTI_GRAVITY: (enabledFeatures & (1 << 24)) != 0,
    };
  }

  isFieldDisabled() {
    const disabledFields = this.getSysConfig().fields_disabled_mask;
    return {
      PID: (disabledFields & (1 << 0)) !== 0,
      RC_COMMANDS: (disabledFields & (1 << 1)) !== 0,
      SETPOINT: (disabledFields & (1 << 2)) !== 0,
      BATTERY: (disabledFields & (1 << 3)) !== 0,
      MAGNETOMETER: (disabledFields & (1 << 4)) !== 0,
      ALTITUDE: (disabledFields & (1 << 5)) !== 0,
      RSSI: (disabledFields & (1 << 6)) !== 0,
      GYRO: (disabledFields & (1 << 7)) !== 0,
      ACC: (disabledFields & (1 << 8)) !== 0,
      DEBUG: (disabledFields & (1 << 9)) !== 0,
      MOTORS: (disabledFields & (1 << 10)) !== 0,
      GPS: (disabledFields & (1 << 11)) !== 0,
    };
  }
}
