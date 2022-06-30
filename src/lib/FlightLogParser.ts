import {
  FIRMWARE_TYPE_BASEFLIGHT,
  FIRMWARE_TYPE_BETAFLIGHT,
  FIRMWARE_TYPE_CLEANFLIGHT,
  FIRMWARE_TYPE_INAV,
  FIRMWARE_TYPE_UNKNOWN,
} from "./configs/FirmwareTypes";
import { adjustFieldDefsList, FlightLogEvent } from "./FlightLogFieldDefs";
import { ArrayDataStream, COLON, EOF } from "./utils/ArrayDataStream";
import { Jq } from "./utils/Jq";
import {
  hexToFloat,
  parseCommaSeparatedString,
  semverGte,
  signExtend14Bit,
  stringHasComma,
} from "./utils/Utils";

export class FlightLogParser {
  //Private variables:
  dataVersion;

  frameTypes;

  // Blackbox state:
  mainHistoryRing;

  /* Points into blackboxHistoryRing to give us a circular buffer.
   *
   * 0 - space to decode new frames into, 1 - previous frame, 2 - previous previous frame
   *
   * Previous frame pointers are null when no valid history exists of that age.
   */
  mainHistory = [null, null, null];
  mainStreamIsValid = false;

  //Because these events don't depend on previous events, we don't keep copies of the old state, just the current one:
  lastEvent;
  lastSlow;

  // How many intentionally un-logged frames did we skip over before we decoded the current frame?
  lastSkippedFrames;

  // Details about the last main frame that was successfully parsed
  lastMainFrameIteration;
  lastMainFrameTime;

  //The actual log data stream we're reading:
  stream;

  frameDefs;
  sysConfig;
  onFrameReady;
  stats: {
    totalBytes: number;
    // Number of frames that failed to decode:
    totalCorruptedFrames: number;
    // If our sampling rate is less than 1, we won't log every loop iteration,
    // and that is accounted for here:
    intentionallyAbsentIterations: number;
    // Statistics for each frame type ("I", "P" etc)
    frame: {};
  };

  constructor(logData) {
    /*
     * Event handler of the signature (frameValid, frame, frameType, frameOffset,
     * frameSize) called when a frame has been decoded.
     */
    this.onFrameReady = null;

    /* Information about the frame types the log contains, along with details on their fields.
     * Each entry is an object with field details {encoding:[], predictor:[], name:[], count:0, signed:[]}
     */
    this.frameDefs = {};

    // Lets add the custom extensions
    const completeSysConfig = Jq.extend(
      {},
      defaultSysConfig,
      defaultSysConfigExtension
    );
    this.sysConfig = Object.create(completeSysConfig); // Object.create(defaultSysConfig);

    this.frameTypes = {
      I: {
        marker: "I",
        parse: this._parseIntraframe,
        complete: this._completeIntraframe,
      },
      P: {
        marker: "P",
        parse: this._parseInterframe,
        complete: this._completeInterframe,
      },
      S: {
        marker: "S",
        parse: this._parseSlowFrame,
        complete: this._completeSlowFrame,
      },
      E: {
        marker: "E",
        parse: this._parseEventFrame,
        complete: this._completeEventFrame,
      },
    };

    this.stream = new ArrayDataStream(logData);
  }

  _parseHeaderLine() {
    const line = this.stream.readLine();
    const firstColonIndex = line.indexOf(COLON);
    let fieldName = line.substring(0, firstColonIndex);
    // To accomodate for date time format, e.g. 12:22:22.
    const fieldValue = line.substring(firstColonIndex + 1);

    // Translate the fieldName to the sysConfig parameter name. The fieldName
    // has been changing between versions In this way is easier to maintain the
    // code
    fieldName = fieldNameTranslations[fieldName] ?? fieldName;

    switch (fieldName) {
      case "I interval":
        this.sysConfig.frameIntervalI = parseInt(fieldValue, 10);
        if (this.sysConfig.frameIntervalI < 1)
          this.sysConfig.frameIntervalI = 1;
        break;
      case "P interval":
        {
          const matches = fieldValue.match(/(\d+)\/(\d+)/);

          if (matches) {
            this.sysConfig.frameIntervalPNum = parseInt(matches[1], 10);
            this.sysConfig.frameIntervalPDenom = parseInt(matches[2], 10);
          } else {
            this.sysConfig.frameIntervalPNum = 1;
            this.sysConfig.frameIntervalPDenom = parseInt(fieldValue, 10);
          }
        }
        break;
      case "P denom":
      case "P ratio":
        // Don't do nothing with this, because is the same as
        // frameIntervalI/frameIntervalPDenom so we don't need it
        break;
      case "Data version":
        this.dataVersion = parseInt(fieldValue, 10);
        break;
      case "Firmware type":
        switch (fieldValue) {
          case "Cleanflight":
            this.sysConfig.firmwareType = FIRMWARE_TYPE_CLEANFLIGHT;
            break;
          default:
            this.sysConfig.firmwareType = FIRMWARE_TYPE_BASEFLIGHT;
        }
        break;

      // Betaflight Log Header Parameters
      case "minthrottle":
        this.sysConfig[fieldName] = parseInt(fieldValue, 10);
        this.sysConfig.motorOutput[0] = this.sysConfig[fieldName]; // by default, set the minMotorOutput to match minThrottle
        break;
      case "maxthrottle":
        this.sysConfig[fieldName] = parseInt(fieldValue, 10);
        this.sysConfig.motorOutput[1] = this.sysConfig[fieldName]; // by default, set the maxMotorOutput to match maxThrottle
        break;
      case "rcRate":
      case "thrMid":
      case "thrExpo":
      case "dynThrPID":
      case "tpa_breakpoint":
      case "airmode_activate_throttle":
      case "serialrx_provider":
      case "looptime":
      case "gyro_sync_denom":
      case "pid_process_denom":
      case "pidController":
      case "yaw_p_limit":
      case "dterm_average_count":
      case "rollPitchItermResetRate":
      case "yawItermResetRate":
      case "rollPitchItermIgnoreRate":
      case "yawItermIgnoreRate":
      case "dterm_differentiator":
      case "deltaMethod":
      case "dynamic_dterm_threshold":
      case "dynamic_pterm":
      case "iterm_reset_offset":
      case "deadband":
      case "yaw_deadband":
      case "gyro_lpf":
      case "gyro_hardware_lpf":
      case "gyro_32khz_hardware_lpf":
      case "acc_lpf_hz":
      case "acc_hardware":
      case "baro_hardware":
      case "mag_hardware":
      case "gyro_cal_on_first_arm":
      case "vbat_pid_compensation":
      case "rc_smoothing":
      case "rc_smoothing_auto_factor":
      case "rc_smoothing_type":
      case "rc_smoothing_debug_axis":
      case "rc_smoothing_rx_average":
      case "superExpoYawMode":
      case "features":
      case "dynamic_pid":
      case "rc_interpolation":
      case "rc_interpolation_channels":
      case "rc_interpolation_interval":
      case "unsynced_fast_pwm":
      case "fast_pwm_protocol":
      case "motor_pwm_rate":
      case "vbatscale":
      case "vbatref":
      case "acc_1G":
      case "dterm_filter_type":
      case "dterm_filter2_type":
      case "pidAtMinThrottle":
      case "pidSumLimit":
      case "pidSumLimitYaw":
      case "anti_gravity_threshold":
      case "itermWindupPointPercent":
      case "ptermSRateWeight":
      case "setpointRelaxRatio":
      case "feedforward_transition":
      case "dtermSetpointWeight":
      case "gyro_soft_type":
      case "gyro_soft2_type":
      case "debug_mode":
      case "anti_gravity_mode":
      case "anti_gravity_gain":
      case "abs_control_gain":
      case "use_integrated_yaw":
      case "d_min_gain":
      case "d_min_advance":
      case "dshot_bidir":
      case "gyro_rpm_notch_harmonics":
      case "gyro_rpm_notch_q":
      case "gyro_rpm_notch_min":
      case "dterm_rpm_notch_harmonics":
      case "dterm_rpm_notch_q":
      case "dterm_rpm_notch_min":
      case "iterm_relax":
      case "iterm_relax_type":
      case "iterm_relax_cutoff":
      case "dyn_notch_range":
      case "dyn_notch_width_percent":
      case "dyn_notch_q":
      case "dyn_notch_min_hz":
      case "dyn_notch_max_hz":
      case "rates_type":
      case "vbat_sag_compensation":
      case "fields_disabled_mask":
      case "motor_pwm_protocol":
        this.sysConfig[fieldName] = parseInt(fieldValue, 10);
        break;
      case "rc_expo":
      case "rc_rates":
        if (stringHasComma(fieldValue)) {
          this.sysConfig[fieldName] = parseCommaSeparatedString(fieldValue);
        } else {
          this.sysConfig[fieldName][0] = parseInt(fieldValue, 10);
          this.sysConfig[fieldName][1] = parseInt(fieldValue, 10);
        }
        break;
      case "rcYawExpo":
        this.sysConfig["rc_expo"][2] = parseInt(fieldValue, 10);
        break;
      case "rcYawRate":
        this.sysConfig["rc_rates"][2] = parseInt(fieldValue, 10);
        break;

      case "yawRateAccelLimit":
      case "rateAccelLimit":
        if (
          (this.sysConfig.firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
            semverGte(this.sysConfig.firmwareVersion, "3.1.0")) ||
          (this.sysConfig.firmwareType == FIRMWARE_TYPE_CLEANFLIGHT &&
            semverGte(this.sysConfig.firmwareVersion, "2.0.0"))
        ) {
          this.sysConfig[fieldName] = parseInt(fieldValue, 10) / 1000;
        } else {
          this.sysConfig[fieldName] = parseInt(fieldValue, 10);
        }
        break;

      case "yaw_lpf_hz":
      case "gyro_lowpass_hz":
      case "gyro_lowpass2_hz":
      case "dterm_notch_hz":
      case "dterm_notch_cutoff":
      case "dterm_lpf_hz":
      case "dterm_lpf2_hz":
        if (
          (this.sysConfig.firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
            semverGte(this.sysConfig.firmwareVersion, "3.0.1")) ||
          (this.sysConfig.firmwareType == FIRMWARE_TYPE_CLEANFLIGHT &&
            semverGte(this.sysConfig.firmwareVersion, "2.0.0"))
        ) {
          this.sysConfig[fieldName] = parseInt(fieldValue, 10);
        } else {
          this.sysConfig[fieldName] = parseInt(fieldValue, 10) / 100.0;
        }
        break;

      case "gyro_notch_hz":
      case "gyro_notch_cutoff":
        if (
          (this.sysConfig.firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
            semverGte(this.sysConfig.firmwareVersion, "3.0.1")) ||
          (this.sysConfig.firmwareType == FIRMWARE_TYPE_CLEANFLIGHT &&
            semverGte(this.sysConfig.firmwareVersion, "2.0.0"))
        ) {
          this.sysConfig[fieldName] = parseCommaSeparatedString(fieldValue);
        } else {
          this.sysConfig[fieldName] = parseInt(fieldValue, 10) / 100.0;
        }
        break;

      case "digitalIdleOffset":
        this.sysConfig[fieldName] = parseInt(fieldValue, 10) / 100.0;

      /**  Cleanflight Only log headers **/
      case "dterm_cut_hz":
      case "acc_cut_hz":
        this.sysConfig[fieldName] = parseInt(fieldValue, 10);
        break;
      /** End of cleanflight only log headers **/

      case "superExpoFactor":
        if (stringHasComma(fieldValue)) {
          const expoParams = parseCommaSeparatedString(fieldValue);
          this.sysConfig.superExpoFactor = expoParams[0];
          this.sysConfig.superExpoFactorYaw = expoParams[1];
        } else {
          this.sysConfig.superExpoFactor = parseInt(fieldValue, 10);
        }
        break;

      /* CSV packed values */
      case "rates":
      case "rate_limits":
      case "rollPID":
      case "pitchPID":
      case "yawPID":
      case "altPID":
      case "posPID":
      case "posrPID":
      case "navrPID":
      case "levelPID":
      case "velPID":
      case "motorOutput":
      case "rc_smoothing_active_cutoffs":
      case "rc_smoothing_cutoffs":
      case "rc_smoothing_filter_type":
      case "gyro_lowpass_dyn_hz":
      case "dterm_lpf_dyn_hz":
      case "d_min":
        this.sysConfig[fieldName] = parseCommaSeparatedString(fieldValue);
        break;
      case "magPID":
        this.sysConfig.magPID = parseCommaSeparatedString(fieldValue, 3); //[parseInt(fieldValue, 10), null, null];
        break;

      case "feedforward_weight":
        // Add it to the end of the rollPID, pitchPID and yawPID
        var ffValues = parseCommaSeparatedString(fieldValue);
        this.sysConfig["rollPID"].push(ffValues[0]);
        this.sysConfig["pitchPID"].push(ffValues[1]);
        this.sysConfig["yawPID"].push(ffValues[2]);
        break;
      /* End of CSV packed values */

      case "vbatcellvoltage":
        var vbatcellvoltageParams = parseCommaSeparatedString(fieldValue);

        this.sysConfig.vbatmincellvoltage = vbatcellvoltageParams[0];
        this.sysConfig.vbatwarningcellvoltage = vbatcellvoltageParams[1];
        this.sysConfig.vbatmaxcellvoltage = vbatcellvoltageParams[2];
        break;
      case "currentMeter":
      case "currentSensor":
        var currentMeterParams = parseCommaSeparatedString(fieldValue);

        this.sysConfig.currentMeterOffset = currentMeterParams[0];
        this.sysConfig.currentMeterScale = currentMeterParams[1];
        break;
      case "gyro.scale":
      case "gyro_scale":
        this.sysConfig.gyroScale = hexToFloat(fieldValue);

        /* Baseflight uses a gyroScale that'll give radians per microsecond as output, whereas Cleanflight produces degrees
         * per second and leaves the conversion to radians per us to the IMU. Let's just convert Cleanflight's scale to
         * match Baseflight so we can use Baseflight's IMU for both: */
        if (
          this.sysConfig.firmwareType == FIRMWARE_TYPE_INAV ||
          this.sysConfig.firmwareType == FIRMWARE_TYPE_CLEANFLIGHT ||
          this.sysConfig.firmwareType == FIRMWARE_TYPE_BETAFLIGHT
        ) {
          this.sysConfig.gyroScale =
            this.sysConfig.gyroScale * (Math.PI / 180.0) * 0.000001;
        }
        break;
      case "Firmware revision":
        detectFirmwareVersion(this.sysConfig, fieldName, fieldValue);
        break;
      case "Product":
      case "Blackbox version":
      case "Firmware date":
      case "Board information":
      case "Craft name":
      case "Log start datetime":
        // These fields are not presently used for anything, ignore them here so we don't warn about unsupported headers
        // Just Add them anyway
        this.sysConfig[fieldName] = fieldValue;
        break;
      case "Device UID":
        this.sysConfig.deviceUID = fieldValue;
        break;
      default:
        const matches = fieldName.match(/^Field (.) (.+)$/);
        if (matches) {
          var frameName = matches[1],
            frameInfo = matches[2],
            frameDef;

          if (!this.frameDefs[frameName]) {
            this.frameDefs[frameName] = {
              name: [],
              nameToIndex: {},
              count: 0,
              signed: [],
              predictor: [],
              encoding: [],
            };
          }

          frameDef = this.frameDefs[frameName];

          switch (frameInfo) {
            case "predictor":
              frameDef.predictor = parseCommaSeparatedString(fieldValue);
              break;
            case "encoding":
              frameDef.encoding = parseCommaSeparatedString(fieldValue);
              break;
            case "name":
              frameDef.name = translateLegacyFieldNames(fieldValue.split(","));
              frameDef.count = frameDef.name.length;

              frameDef.nameToIndex = mapFieldNamesToIndex(frameDef.name);

              /*
               * We could survive with the `signed` header just being filled with zeros, so if it is absent
               * then resize it to length.
               */
              frameDef.signed.length = frameDef.count;
              break;
            case "signed":
              frameDef.signed = parseCommaSeparatedString(fieldValue);
              break;
            default:
              console.log('Unrecognized field header "' + fieldName + '"');
          }
        } else {
          if (this.sysConfig.unknownHeaders == null)
            this.sysConfig.unknownHeaders = new Array();
          this.sysConfig.unknownHeaders.push({
            name: fieldName,
            value: fieldValue,
          }); // Save the unknown headers
        }
        break;
    }
  }

  invalidateMainStream() {
    this.mainStreamIsValid = false;

    this.mainHistory[0] = this.mainHistoryRing ? this.mainHistoryRing[0] : null;
    this.mainHistory[1] = null;
    this.mainHistory[2] = null;
  }

  resetStats() {
    this.stats = {
      totalBytes: 0,

      // Number of frames that failed to decode:
      totalCorruptedFrames: 0,

      // If our sampling rate is less than 1, we won't log every loop iteration,
      // and that is accounted for here:
      intentionallyAbsentIterations: 0,

      // Statistics for each frame type ("I", "P" etc)
      frame: {},
    };
  }

  /**
   * Use data from the given frame to update field statistics for the given
   * frame type.
   */
  private _updateFieldStats(frameType, frame) {
    const fieldStats = this.stats.frame[frameType].field;

    for (let i = 0; i < frame.length; i++) {
      if (!fieldStats[i]) {
        fieldStats[i] = {
          max: frame[i],
          min: frame[i],
        };
      } else {
        fieldStats[i].max = Math.max(frame[i], fieldStats[i].max);
        fieldStats[i].min = Math.min(frame[i], fieldStats[i].min);
      }
    }
  }

  private _completeIntraframe = (frameType, frameStart, frameEnd) => {
    const iteration = this._currentFrame[FLIGHT_LOG_FIELD_INDEX_ITERATION];
    const time = this._currentFrame[FLIGHT_LOG_FIELD_INDEX_TIME];

    let isFrameValid = true;
    // Do we have a previous frame to use as a reference to validate field
    // values against?
    if (this.lastMainFrameIteration != -1) {
      // Check that iteration count and time didn't move backwards, and didn't
      // move forward too much.
      isFrameValid =
        this.lastMainFrameIteration <= iteration &&
        iteration <
          this.lastMainFrameIteration + MAXIMUM_ITERATION_JUMP_BETWEEN_FRAMES &&
        this.lastMainFrameTime <= time &&
        time < this.lastMainFrameTime + MAXIMUM_TIME_JUMP_BETWEEN_FRAMES;
    }

    if (isFrameValid) {
      this.stats.intentionallyAbsentIterations +=
        this._countIntentionallySkippedFramesTo(iteration);

      this.lastMainFrameIteration = iteration;
      this.lastMainFrameTime = time;

      this.mainStreamIsValid = true;

      this._updateFieldStats(frameType, this._currentFrame);
    } else {
      this.invalidateMainStream();
    }

    if (this.onFrameReady) {
      this.onFrameReady(
        this.mainStreamIsValid,
        this._currentFrame,
        frameType,
        frameStart,
        frameEnd - frameStart
      );
    }

    this._rotateHistoryBuffers({ isIntraFrame: true });
  };

  private get _currentFrame() {
    return this.mainHistory[0];
  }

  private get _previousFrame() {
    return this.mainHistory[1];
  }

  private get _prevPreviousFrame() {
    return this.mainHistory[2];
  }

  private _rotateHistoryBuffers({ isIntraFrame }) {
    if (isIntraFrame) {
      // Both the previous and previous-previous states become the I-frame,
      // because we can't look further into the past than the I-frame
      this.mainHistory[1] = this._currentFrame;
      this.mainHistory[2] = this._currentFrame;
    } else {
      this.mainHistory[2] = this._previousFrame;
      this.mainHistory[1] = this._currentFrame;
    }

    // And advance the current frame into an empty space ready to be filled.
    this.mainHistory[0] =
      this.mainHistoryRing[
        (this.mainHistoryRing.indexOf(this.mainHistory[0]) + 1) % 3
      ];
  }

  /**
   * Should a frame with the given index exist in this log (based on the user's
   * selection of sampling rates)?
   */
  _shouldHaveFrame(frameIndex) {
    return (
      ((frameIndex % this.sysConfig.frameIntervalI) +
        this.sysConfig.frameIntervalPNum -
        1) %
        this.sysConfig.frameIntervalPDenom <
      this.sysConfig.frameIntervalPNum
    );
  }

  /**
   * Attempt to parse the frame of into the supplied `current` buffer using the
   * encoding/predictor definitions from `frameDefs`. The previous frame values
   * are used for predictions.
   *
   * frameDef - The definition for the frame type being parsed (from
   * this.frameDefs) skippedFrames - Set to the number of field iterations that
   * were skipped over by rate settings since the last frame.
   */
  parseFrame(frameDef, current, previous, previous2, skippedFrames = 0) {
    const predictor = frameDef.predictor;
    const encoding = frameDef.encoding;
    const values = new Array(8);
    let j = 0;

    let fieldIndex = 0;
    while (fieldIndex < frameDef.count) {
      // Auto increment.
      if (predictor[fieldIndex] == FLIGHT_LOG_FIELD_PREDICTOR_INC) {
        current[fieldIndex] = skippedFrames + 1;

        if (previous) current[fieldIndex] += previous[fieldIndex];

        fieldIndex++;
        continue;
      }

      let value;

      switch (encoding[fieldIndex]) {
        case FLIGHT_LOG_FIELD_ENCODING_SIGNED_VB:
          value = this.stream.readSignedVB();
          break;
        case FLIGHT_LOG_FIELD_ENCODING_UNSIGNED_VB:
          value = this.stream.readUnsignedVB();
          break;
        case FLIGHT_LOG_FIELD_ENCODING_NEG_14BIT:
          value = -signExtend14Bit(this.stream.readUnsignedVB());
          break;
        case FLIGHT_LOG_FIELD_ENCODING_NULL:
          //Nothing to read
          value = 0;
          break;
        case FLIGHT_LOG_FIELD_ENCODING_TAG8_4S16:
          if (this.dataVersion < 2) this.stream.readTag8_4S16_v1(values);
          else this.stream.readTag8_4S16_v2(values);

          //Apply the predictors for the fields:
          for (j = 0; j < 4; j++, fieldIndex++) {
            current[fieldIndex] = this._applyPrediction(
              fieldIndex,
              predictor[fieldIndex],
              values[j],
              current,
              previous,
              previous2
            );
          }

          continue;
        case FLIGHT_LOG_FIELD_ENCODING_TAG2_3S32:
          this.stream.readTag2_3S32(values);

          //Apply the predictors for the fields:
          for (j = 0; j < 3; j++, fieldIndex++) {
            current[fieldIndex] = this._applyPrediction(
              fieldIndex,
              predictor[fieldIndex],
              values[j],
              current,
              previous,
              previous2
            );
          }

          continue;
        case FLIGHT_LOG_FIELD_ENCODING_TAG2_3SVARIABLE:
          this.stream.readTag2_3SVariable(values);

          //Apply the predictors for the fields:
          for (j = 0; j < 3; j++, fieldIndex++) {
            current[fieldIndex] = this._applyPrediction(
              fieldIndex,
              predictor[fieldIndex],
              values[j],
              current,
              previous,
              previous2
            );
          }

          continue;
        case FLIGHT_LOG_FIELD_ENCODING_TAG8_8SVB:
          // How many fields are in this encoded group?
          // Check the subsequent field encodings:
          for (
            j = fieldIndex + 1;
            j < fieldIndex + 8 && j < frameDef.count;
            j++
          )
            if (encoding[j] != FLIGHT_LOG_FIELD_ENCODING_TAG8_8SVB) break;

          const groupCount = j - fieldIndex;

          this.stream.readTag8_8SVB(values, groupCount);

          for (j = 0; j < groupCount; j++, fieldIndex++) {
            current[fieldIndex] = this._applyPrediction(
              fieldIndex,
              predictor[fieldIndex],
              values[j],
              current,
              previous,
              previous2
            );
          }

          continue;
        default:
          if (encoding[fieldIndex] === undefined)
            throw (
              "Missing field encoding header for field #" +
              fieldIndex +
              " '" +
              frameDef.name[fieldIndex] +
              "'"
            );
          else throw "Unsupported field encoding " + encoding[fieldIndex];
      }

      current[fieldIndex] = this._applyPrediction(
        fieldIndex,
        predictor[fieldIndex],
        value,
        current,
        previous,
        previous2
      );

      fieldIndex++;
    }
  }

  // I frame.
  private _parseIntraframe = () => {
    this.parseFrame(
      this.frameDefs.I,
      this._currentFrame,
      this._previousFrame,
      null
    );
  };

  private _completeSlowFrame = (frameType, frameStart, frameEnd) => {
    this._updateFieldStats(frameType, this.lastSlow);

    if (this.onFrameReady) {
      this.onFrameReady(
        true,
        this.lastSlow,
        frameType,
        frameStart,
        frameEnd - frameStart
      );
    }
  };

  // P frame.
  private _completeInterframe = (frameType, frameStart, frameEnd) => {
    const time = this._currentFrame[FLIGHT_LOG_FIELD_INDEX_TIME];
    const iteration = this._currentFrame[FLIGHT_LOG_FIELD_INDEX_ITERATION];

    // Reject this frame if the time or iteration count jumped too far
    if (
      this.mainStreamIsValid &&
      (time > this.lastMainFrameTime + MAXIMUM_TIME_JUMP_BETWEEN_FRAMES ||
        iteration >
          this.lastMainFrameIteration + MAXIMUM_ITERATION_JUMP_BETWEEN_FRAMES)
    ) {
      this.mainStreamIsValid = false;
    }

    if (this.mainStreamIsValid) {
      this.lastMainFrameIteration = iteration;
      this.lastMainFrameTime = time;

      this.stats.intentionallyAbsentIterations += this.lastSkippedFrames;

      this._updateFieldStats(frameType, this._currentFrame);
    }

    // Receiving a P frame can't resynchronise the stream so it doesn't set
    // this.mainStreamIsValid to true

    if (this.onFrameReady) {
      this.onFrameReady(
        this.mainStreamIsValid,
        this._currentFrame,
        frameType,
        frameStart,
        frameEnd - frameStart
      );
    }

    if (this.mainStreamIsValid) {
      this._rotateHistoryBuffers({ isIntraFrame: false });
    }
  };

  /**
   * Take the raw value for a a field, apply the prediction that is configured
   * for it, and return it.
   */
  private _applyPrediction(
    fieldIndex,
    predictor,
    value,
    current,
    previous,
    previous2
  ) {
    switch (predictor) {
      case FLIGHT_LOG_FIELD_PREDICTOR_0:
        // No correction to apply
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_MINMOTOR:
        /*
         * Force the value to be a *signed* 32-bit integer. Encoded motor values
         * can be negative when motors are below minthrottle, but despite this
         * motor[0] is encoded in I-frames using *unsigned* encoding (to save
         * space for positive values). So we need to convert those very large
         * unsigned values into their corresponding 32-bit signed values.
         */
        // motorOutput[0] is the min motor output
        value = (value | 0) + (this.sysConfig.motorOutput[0] | 0);
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_1500:
        value += 1500;
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_MOTOR_0:
        if (this.frameDefs.I.nameToIndex["motor[0]"] < 0) {
          throw (
            "Attempted to base I-field prediction on motor0 before it was " +
            "read"
          );
        }
        value += current[this.frameDefs.I.nameToIndex["motor[0]"]];
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_VBATREF:
        value += this.sysConfig.vbatref;
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_PREVIOUS:
        if (!previous) break;

        value += previous[fieldIndex];
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_STRAIGHT_LINE:
        if (!previous) break;

        value += 2 * previous[fieldIndex] - previous2[fieldIndex];
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_AVERAGE_2:
        if (!previous) break;

        //Round toward zero like C would do for integer division:
        value += ~~((previous[fieldIndex] + previous2[fieldIndex]) / 2);
        break;
      case FLIGHT_LOG_FIELD_PREDICTOR_LAST_MAIN_FRAME_TIME:
        if (this.mainHistory[1])
          value += this.mainHistory[1][FLIGHT_LOG_FIELD_INDEX_TIME];
        break;
      default:
        console.error("Unsupported field predictor " + predictor);
    }

    return value;
  }

  /*
   * Based on the log sampling rate, work out how many frames would have been
   * skipped after the last frame that was parsed until we get to the next
   * logged iteration.
   */
  _countIntentionallySkippedFrames() {
    if (this.lastMainFrameIteration == -1) {
      // Haven't parsed a frame yet so there's no frames to skip.
      return 0;
    }

    let count = 0;
    for (
      let frameIndex = this.lastMainFrameIteration + 1;
      !this._shouldHaveFrame(frameIndex);
      frameIndex++
    ) {
      count++;
    }

    return count;
  }

  /*
   * Based on the log sampling rate, work out how many frames would have been
   * skipped after the last frame that was parsed until we get to the iteration
   * with the given index.
   */
  _countIntentionallySkippedFramesTo(targetIteration) {
    var count = 0,
      frameIndex;

    if (this.lastMainFrameIteration == -1) {
      // Haven't parsed a frame yet so there's no frames to skip
      return 0;
    } else {
      for (
        frameIndex = this.lastMainFrameIteration + 1;
        frameIndex < targetIteration;
        frameIndex++
      ) {
        if (!this._shouldHaveFrame(frameIndex)) {
          count++;
        }
      }
    }

    return count;
  }

  _parseInterframe = () => {
    this.lastSkippedFrames = this._countIntentionallySkippedFrames();

    this.parseFrame(
      this.frameDefs.P,
      this._currentFrame,
      this._previousFrame,
      this._prevPreviousFrame,
      this.lastSkippedFrames
    );
  };

  _parseSlowFrame = () => {
    if (this.frameDefs.S) {
      this.parseFrame(this.frameDefs.S, this.lastSlow, null, null);
    }
  };

  _completeEventFrame = (frameType, frameStart, frameEnd) => {
    if (!this.lastEvent) return false;

    switch (this.lastEvent.event) {
      case FlightLogEvent.LOGGING_RESUME:
        /*
         * Bring the "last time" and "last iteration" up to the new resume
         * time so we accept the sudden jump into the future.
         */
        this.lastMainFrameIteration = this.lastEvent.data.logIteration;
        this.lastMainFrameTime = this.lastEvent.data.currentTime;
        break;
    }

    if (this.onFrameReady) {
      this.onFrameReady(
        true,
        this.lastEvent,
        frameType,
        frameStart,
        frameEnd - frameStart
      );
    }

    return true;
  };

  _parseEventFrame = (raw) => {
    var END_OF_LOG_MESSAGE = "End of log\0",
      eventType = this.stream.readByte();

    this.lastEvent = {
      event: eventType,
      data: {},
    };

    // See: https://github.com/betaflight/betaflight/blob/master/src/main/blackbox/blackbox.c#L1507
    switch (eventType) {
      case FlightLogEvent.SYNC_BEEP:
        const time = this.stream.readUnsignedVB();
        this.lastEvent.data.time = time;
        this.lastEvent.time = time;
        break;
      case FlightLogEvent.FLIGHT_MODE: // get the flag status change
        this.lastEvent.data.newFlags = this.stream.readUnsignedVB();
        this.lastEvent.data.lastFlags = this.stream.readUnsignedVB();
        break;
      case FlightLogEvent.DISARM:
        this.lastEvent.data.reason = this.stream.readUnsignedVB();
        break;
      case FlightLogEvent.LOGGING_RESUME:
        this.lastEvent.data.logIteration = this.stream.readUnsignedVB();
        this.lastEvent.data.currentTime = this.stream.readUnsignedVB();
        break;
      case FlightLogEvent.LOG_END:
        var endMessage = this.stream.readString(END_OF_LOG_MESSAGE.length);

        if (endMessage == END_OF_LOG_MESSAGE) {
          //Adjust the end of this.stream so we stop reading, this log is done
          this.stream.end = this.stream.pos;
        } else {
          /*
           * This isn't the real end of log message, it's probably just some bytes that happened to look like
           * an event header.
           */
          this.lastEvent = null;
        }
        break;
      default:
        this.lastEvent = null;
    }
  };

  // Reset parsing state from the data section of the current log (don't reset
  // header information). Useful for seeking.
  resetDataState() {
    this.lastSkippedFrames = 0;

    this.lastMainFrameIteration = -1;
    this.lastMainFrameTime = -1;

    this.invalidateMainStream();
    this.lastEvent = null;
  }

  // Reset any parsed information from previous parses (header & data)
  private _resetAllState() {
    this.resetStats();

    // Reset system configuration to MW's defaults
    // Lets add the custom extensions
    const completeSysConfig = Jq.extend(
      {},
      defaultSysConfig,
      defaultSysConfigExtension
    );
    this.sysConfig = Object.create(completeSysConfig);

    this.frameDefs = {};

    this.resetDataState();
  }

  // Check that the given frame definition contains some fields and the right
  // number of predictors & encodings to match
  private _isFrameDefComplete(frameDef) {
    return (
      frameDef &&
      frameDef.count > 0 &&
      frameDef.encoding.length == frameDef.count &&
      frameDef.predictor.length == frameDef.count
    );
  }

  private _setStreamRange(startOffset, endOffset) {
    // Set parsing ranges up for the log the caller selected.
    this.stream.start = startOffset ?? this.stream.pos;
    this.stream.pos = this.stream.start;
    this.stream.end = endOffset ?? this.stream.end;
    this.stream.eof = false;
  }

  parseHeader(startOffset, endOffset) {
    this._resetAllState();
    this._setStreamRange(startOffset, endOffset);

    mainloop: while (true) {
      const command = this.stream.readChar();

      switch (command) {
        case "H":
          if (this.stream.peekChar() != " ") {
            console.warn("Unexpected header format.");
            break;
          }

          // Skip the leading space
          this.stream.readChar();

          this._parseHeaderLine();
          break;
        case EOF:
          break mainloop;
        default: // else skip garbage which apparently precedes the first data frame
          /*
           * If we see something that looks like the beginning of a data frame,
           * assume it is and terminate the header.
           */
          if (this.frameTypes[command]) {
            this.stream.unreadChar(command);

            break mainloop;
          }
          break;
      }
    }

    adjustFieldDefsList(
      this.sysConfig.firmwareType,
      this.sysConfig.firmwareVersion
    );

    if (!this._isFrameDefComplete(this.frameDefs.I)) {
      throw (
        "Log is missing required definitions for I frames, " +
        "header may be corrupt"
      );
    }

    if (!this.frameDefs.P) {
      throw (
        "Log is missing required definitions for P frames, " +
        "header may be corrupt"
      );
    }

    // P frames are derived from I frames so copy over frame definition
    // information to those.
    this.frameDefs.P.count = this.frameDefs.I.count;
    this.frameDefs.P.name = this.frameDefs.I.name;
    this.frameDefs.P.nameToIndex = this.frameDefs.I.nameToIndex;
    this.frameDefs.P.signed = this.frameDefs.I.signed;

    if (!this._isFrameDefComplete(this.frameDefs.P)) {
      throw (
        "Log is missing required definitions for P frames, " +
        "header may be corrupt"
      );
    }

    // Now we know our field counts, we can allocate arrays to hold parsed data.
    this.mainHistoryRing = [
      new Array(this.frameDefs.I.count),
      new Array(this.frameDefs.I.count),
      new Array(this.frameDefs.I.count),
    ];

    if (this.frameDefs.S) {
      this.lastSlow = new Array(this.frameDefs.S.count);
    } else {
      this.lastSlow = [];
    }
  }

  /**
   * Continue the current parse by scanning the given range of offsets for data.
   * To begin an independent parse, call resetDataState() first.
   */
  parseLogData(startOffset = null, endOffset = null) {
    let looksLikeFrameCompleted = false,
      prematureEof = false,
      frameStart = 0,
      frameType = null,
      lastFrameType = null;

    this.invalidateMainStream();
    this._setStreamRange(startOffset, endOffset);

    while (true) {
      const command = this.stream.readChar();

      if (lastFrameType) {
        let lastFrameSize = this.stream.pos - frameStart,
          frameTypeStats;

        // Is this the beginning of a new frame?
        looksLikeFrameCompleted =
          this.frameTypes[command] || (!prematureEof && command == EOF);

        if (!this.stats.frame[lastFrameType.marker]) {
          this.stats.frame[lastFrameType.marker] = {
            bytes: 0,
            sizeCount: new Int32Array(
              256
            ) /* int32 arrays are zero-filled, handy! */,
            validCount: 0,
            corruptCount: 0,
            field: [],
          };
        }

        frameTypeStats = this.stats.frame[lastFrameType.marker];

        // If we see what looks like the beginning of a new frame, assume that
        // the previous frame was valid:
        if (
          lastFrameSize <= FLIGHT_LOG_MAX_FRAME_LENGTH &&
          looksLikeFrameCompleted
        ) {
          var frameAccepted = true;

          if (lastFrameType.complete)
            frameAccepted = lastFrameType.complete(
              lastFrameType.marker,
              frameStart,
              this.stream.pos
            );

          if (frameAccepted) {
            //Update statistics for this frame type
            frameTypeStats.bytes += lastFrameSize;
            frameTypeStats.sizeCount[lastFrameSize]++;
            frameTypeStats.validCount++;
          } else {
            frameTypeStats.desyncCount++;
          }
        } else {
          //The previous frame was corrupt.

          //We need to resynchronise before we can deliver another main frame:
          this.mainStreamIsValid = false;
          frameTypeStats.corruptCount++;
          this.stats.totalCorruptedFrames++;

          // Let the caller know there was a corrupt frame (don't give them a
          // pointer to the frame data because it is totally worthless)
          if (this.onFrameReady)
            this.onFrameReady(
              false,
              null,
              lastFrameType.marker,
              frameStart,
              lastFrameSize
            );

          /*
           * Start the search for a frame beginning after the first byte of the
           * previous corrupt frame. This way we can find the start of the next
           * frame after the corrupt frame if the corrupt frame was truncated.
           */
          this.stream.pos = frameStart + 1;
          lastFrameType = null;
          prematureEof = false;
          this.stream.eof = false;
          continue;
        }
      }

      if (command == EOF) break;

      frameStart = this.stream.pos - 1;
      frameType = this.frameTypes[command];

      // Reject the frame if it is one that we have no definitions for in the header
      if (frameType && (command == "E" || this.frameDefs[command])) {
        lastFrameType = frameType;
        frameType.parse();

        //We shouldn't read an EOF during reading a frame (that'd imply the frame was truncated)
        if (this.stream.eof) {
          prematureEof = true;
        }
      } else {
        this.mainStreamIsValid = false;
        lastFrameType = null;
      }
    }

    this.stats.totalBytes += this.stream.end - this.stream.start;

    return true;
  }
}

export const FLIGHT_LOG_START_MARKER =
  "H Product:Blackbox flight data recorder by Nicholas Sherlock\n"
    .split("")
    .map((c) => c.charCodeAt(0));

export const FLIGHT_LOG_FIELD_UNSIGNED = 0;
export const FLIGHT_LOG_FIELD_SIGNED = 1;

export const FLIGHT_LOG_FIELD_INDEX_ITERATION = 0;
export const FLIGHT_LOG_FIELD_INDEX_TIME = 1;

function detectFirmwareVersion(sysConfig, fieldName, fieldValue) {
  // TODO Unify this somehow...

  // Extract the firmware revision in case of Betaflight/Raceflight/Cleanfligh 2.x/Other
  let matches = fieldValue.match(/(.*flight).* (\d+)\.(\d+)(\.(\d+))*/i);
  if (matches != null) {
    // Detecting Betaflight requires looking at the revision string
    if (matches[1] === "Betaflight") {
      sysConfig.firmwareType = FIRMWARE_TYPE_BETAFLIGHT;
    }

    sysConfig.firmware = parseFloat(matches[2] + "." + matches[3]).toFixed(1);
    sysConfig.firmwarePatch = matches[5] != null ? parseInt(matches[5]) : "0";
    sysConfig.firmwareVersion =
      sysConfig.firmware + "." + sysConfig.firmwarePatch;
  } else {
    /*
     * Try to detect INAV
     */
    matches = fieldValue.match(/(INAV).* (\d+)\.(\d+).(\d+)*/i);
    if (matches != null) {
      sysConfig.firmwareType = FIRMWARE_TYPE_INAV;
      sysConfig.firmware = parseFloat(matches[2] + "." + matches[3]);
      sysConfig.firmwarePatch = matches[5] != null ? parseInt(matches[5]) : "";
    } else {
      // Cleanflight 1.x and others
      sysConfig.firmwareVersion = "0.0.0";
      sysConfig.firmware = 0.0;
      sysConfig.firmwarePatch = 0;
    }
  }
  sysConfig[fieldName] = fieldValue;
}

function mapFieldNamesToIndex(fieldNames) {
  var result = {};

  for (var i = 0; i < fieldNames.length; i++) {
    result[fieldNames[i]] = i;
  }

  return result;
}

/**
 * Translates old field names in the given array to their modern equivalents and return the passed array.
 */
function translateLegacyFieldNames(names) {
  for (var i = 0; i < names.length; i++) {
    var matches;

    if ((matches = names[i].match(/^gyroData(.+)$/))) {
      names[i] = "gyroADC" + matches[1];
    }
  }

  return names;
}

const defaultSysConfig = {
    frameIntervalI: 32,
    frameIntervalPNum: 1,
    frameIntervalPDenom: 1,
    firmwareType: FIRMWARE_TYPE_UNKNOWN,
    rcRate: 90,
    vbatscale: 110,
    vbatref: 4095,
    vbatmincellvoltage: 33,
    vbatmaxcellvoltage: 43,
    vbatwarningcellvoltage: 35,
    gyroScale: 0.0001, // Not even close to the default, but it's hardware specific so we can't do much better
    acc_1G: 4096, // Ditto ^
    minthrottle: 1150,
    maxthrottle: 1850,
    currentMeterOffset: 0,
    currentMeterScale: 400,
    deviceUID: null,
  },
  // These are now part of the blackbox log header, but they are in addition to the
  // standard logger.

  defaultSysConfigExtension = {
    abs_control_gain: null, // Aboslute control gain
    anti_gravity_gain: null, // Anti gravity gain
    anti_gravity_mode: null, // Anti gravity mode
    anti_gravity_threshold: null, // Anti gravity threshold for step mode
    thrMid: null, // Throttle Mid Position
    thrExpo: null, // Throttle Expo
    tpa_breakpoint: null, // TPA Breakpoint
    airmode_activate_throttle: null, // airmode activation level
    serialrx_provider: null, // name of the serial rx provider
    superExpoFactor: null, // Super Expo Factor
    rates: [null, null, null], // Rates [ROLL, PITCH, YAW]
    rate_limits: [1998, 1998, 1998], // Limits [ROLL, PITCH, YAW] with defaults for backward compatibility
    rc_rates: [null, null, null], // RC Rates [ROLL, PITCH, YAW]
    rc_expo: [null, null, null], // RC Expo [ROLL, PITCH, YAW]
    looptime: null, // Looptime
    gyro_sync_denom: null, // Gyro Sync Denom
    pid_process_denom: null, // PID Process Denom
    pidController: null, // Active PID Controller
    rollPID: [null, null, null], // Roll [P, I, D]
    pitchPID: [null, null, null], // Pitch[P, I, D]
    yawPID: [null, null, null], // Yaw  [P, I, D]
    feedforward_transition: null, // Feedforward transition
    altPID: [null, null, null], // Altitude Hold [P, I, D]
    posPID: [null, null, null], // Position Hold [P, I, D]
    posrPID: [null, null, null], // Position Rate [P, I, D]
    navrPID: [null, null, null], // Nav Rate      [P, I, D]
    levelPID: [null, null, null], // Level Mode    [P, I, D]
    magPID: null, // Magnetometer   P
    velPID: [null, null, null], // Velocity      [P, I, D]
    yaw_p_limit: null, // Yaw P Limit
    yaw_lpf_hz: null, // Yaw LowPass Filter Hz
    dterm_average_count: null, // DTerm Average Count
    rollPitchItermResetRate: null, // ITerm Reset rate for Roll and Pitch
    yawItermResetRate: null, // ITerm Reset Rate for Yaw
    dshot_bidir: null, // DShot bidir protocol enabled
    dterm_lpf_hz: null, // DTerm Lowpass Filter Hz
    dterm_lpf_dyn_hz: [null, null], // DTerm Lowpass Dynamic Filter Min and Max Hz
    dterm_lpf2_hz: null, // DTerm Lowpass Filter Hz 2
    dterm_differentiator: null, // DTerm Differentiator
    H_sensitivity: null, // Horizon Sensitivity
    iterm_reset_offset: null, // I-Term reset offset
    deadband: null, // Roll, Pitch Deadband
    yaw_deadband: null, // Yaw Deadband
    gyro_lpf: null, // Gyro lpf setting.
    gyro_32khz_hardware_lpf: null, // Gyro 32khz hardware lpf setting. (post BF3.4)
    gyro_lowpass_hz: null, // Gyro Soft Lowpass Filter Hz
    gyro_lowpass_dyn_hz: [null, null], // Gyro Soft Lowpass Dynamic Filter Min and Max Hz
    gyro_lowpass2_hz: null, // Gyro Soft Lowpass Filter Hz 2
    gyro_notch_hz: null, // Gyro Notch Frequency
    gyro_notch_cutoff: null, // Gyro Notch Cutoff
    gyro_rpm_notch_harmonics: null, // Number of Harmonics in the gyro rpm filter
    gyro_rpm_notch_q: null, // Value of Q in the gyro rpm filter
    gyro_rpm_notch_min: null, // Min Hz for the gyro rpm filter
    dterm_rpm_notch_harmonics: null, // Number of Harmonics in the dterm rpm filter
    dterm_rpm_notch_q: null, // Value of Q in the dterm rpm filter
    dterm_rpm_notch_min: null, // Min Hz for the dterm rpm filter
    dterm_notch_hz: null, // Dterm Notch Frequency
    dterm_notch_cutoff: null, // Dterm Notch Cutoff
    acc_lpf_hz: null, // Accelerometer Lowpass filter Hz
    acc_hardware: null, // Accelerometer Hardware type
    baro_hardware: null, // Barometer Hardware type
    mag_hardware: null, // Magnetometer Hardware type
    gyro_cal_on_first_arm: null, // Gyro Calibrate on first arm
    vbat_pid_compensation: null, // VBAT PID compensation
    // rate_limits:[null, null, null],         // RC Rate limits
    rc_smoothing: null, // RC Control Smoothing
    rc_smoothing_type: null, // Type of the RC Smoothing
    rc_interpolation: null, // RC Control Interpolation type
    rc_interpolation_channels: null, // RC Control Interpotlation channels
    rc_interpolation_interval: null, // RC Control Interpolation Interval
    rc_smoothing_active_cutoffs: [null, null], // RC Smoothing active cutoffs
    rc_smoothing_auto_factor: null, // RC Smoothing auto factor
    rc_smoothing_cutoffs: [null, null], // RC Smoothing input and derivative cutoff
    rc_smoothing_filter_type: [null, null], // RC Smoothing input and derivative type
    rc_smoothing_rx_average: null, // RC Smoothing rx average readed in ms
    rc_smoothing_debug_axis: null, // Axis recorded in the debug mode of rc_smoothing
    dterm_filter_type: null, // D term filtering type (PT1, BIQUAD)
    dterm_filter2_type: null, // D term 2 filtering type (PT1, BIQUAD)
    pidAtMinThrottle: null, // Stabilisation at zero throttle
    itermThrottleGain: null, // Betaflight PID
    ptermSetpointWeight: null, // Betaflight PID
    dtermSetpointWeight: null, // Betaflight PID
    yawRateAccelLimit: null, // Betaflight PID
    rateAccelLimit: null, // Betaflight PID
    gyro_soft_type: null, // Gyro soft filter type (PT1, BIQUAD)
    gyro_soft2_type: null, // Gyro soft filter 2 type (PT1, BIQUAD)
    debug_mode: null, // Selected Debug Mode
    features: null, // Activated features (e.g. MOTORSTOP etc)
    Craft_name: null, // Craft Name
    motorOutput: [null, null], // Minimum and maximum outputs to motor's
    digitalIdleOffset: null, // min throttle for d-shot (as a percentage)
    pidSumLimit: null, // PID sum limit
    pidSumLimitYaw: null, // PID sum limit yaw
    use_integrated_yaw: null, // Use integrated yaw
    d_min: [null, null, null], // D_Min [P, I, D]
    d_min_gain: null, // D_Min gain
    d_min_advance: null, // D_Min advance
    iterm_relax: null, // ITerm Relax mode
    iterm_relax_type: null, // ITerm Relax type
    iterm_relax_cutoff: null, // ITerm Relax cutoff
    dyn_notch_range: null, // Dyn Notch Range (LOW, MED, HIGH or AUTO)
    dyn_notch_width_percent: null, // Dyn Notch width percent distance between the two notches
    dyn_notch_q: null, // Dyn Notch width of each dynamic filter
    dyn_notch_min_hz: null, // Dyn Notch min limit in Hz for the filter
    dyn_notch_max_hz: null, // Dyn Notch max limit in Hz for the filter
    rates_type: null,
    fields_disabled_mask: null,
    vbat_sag_compensation: null,
    unknownHeaders: [], // Unknown Extra Headers
  },
  // Translation of the field values name to the sysConfig var where it must be stored
  fieldNameTranslations = {
    acc_limit_yaw: "yawRateAccelLimit",
    accel_limit: "rateAccelLimit",
    acc_limit: "rateAccelLimit",
    anti_gravity_thresh: "anti_gravity_threshold",
    currentSensor: "currentMeter",
    d_notch_cut: "dterm_notch_cutoff",
    d_setpoint_weight: "dtermSetpointWeight",
    dterm_lowpass_hz: "dterm_lpf_hz",
    dterm_lowpass_dyn_hz: "dterm_lpf_dyn_hz",
    dterm_lowpass2_hz: "dterm_lpf2_hz",
    dterm_setpoint_weight: "dtermSetpointWeight",
    digital_idle_value: "digitalIdleOffset",
    dshot_idle_value: "digitalIdleOffset",
    gyro_hardware_lpf: "gyro_lpf",
    gyro_lowpass: "gyro_lowpass_hz",
    gyro_lowpass_type: "gyro_soft_type",
    gyro_lowpass2_type: "gyro_soft2_type",
    "gyro.scale": "gyro_scale",
    iterm_windup: "itermWindupPointPercent",
    motor_pwm_protocol: "fast_pwm_protocol",
    pidsum_limit: "pidSumLimit",
    pidsum_limit_yaw: "pidSumLimitYaw",
    rc_expo_yaw: "rcYawExpo",
    rc_interp: "rc_interpolation",
    rc_interp_int: "rc_interpolation_interval",
    rc_rate: "rc_rates",
    rc_rate_yaw: "rcYawRate",
    rc_yaw_expo: "rcYawExpo",
    rcExpo: "rc_expo",
    rcRate: "rc_rates",
    setpoint_relax_ratio: "setpointRelaxRatio",
    setpoint_relaxation_ratio: "setpointRelaxRatio",
    thr_expo: "thrExpo",
    thr_mid: "thrMid",
    tpa_rate: "dynThrPID",
    use_unsynced_pwm: "unsynced_fast_pwm",
    vbat_scale: "vbatscale",
    vbat_pid_gain: "vbat_pid_compensation",
    yaw_accel_limit: "yawRateAccelLimit",
    yaw_lowpass_hz: "yaw_lpf_hz",
  };

//Private constants:
const FLIGHT_LOG_MAX_FRAME_LENGTH = 256,
  //Assume that even in the most woeful logging situation, we won't miss 10 seconds of frames
  MAXIMUM_TIME_JUMP_BETWEEN_FRAMES = 10 * 1000000,
  //Likewise for iteration count
  MAXIMUM_ITERATION_JUMP_BETWEEN_FRAMES = 500 * 10,
  // Flight log field predictors:

  // No prediction:
  FLIGHT_LOG_FIELD_PREDICTOR_0 = 0,
  // Predict that the field is the same as last frame:
  FLIGHT_LOG_FIELD_PREDICTOR_PREVIOUS = 1,
  // Predict that the slope between this field and the previous item is the same as that between the past two history items:
  FLIGHT_LOG_FIELD_PREDICTOR_STRAIGHT_LINE = 2,
  // Predict that this field is the same as the average of the last two history items:
  FLIGHT_LOG_FIELD_PREDICTOR_AVERAGE_2 = 3,
  //  Predict that this field is the same as motor 0
  FLIGHT_LOG_FIELD_PREDICTOR_MOTOR_0 = 5,
  // This field always increments
  FLIGHT_LOG_FIELD_PREDICTOR_INC = 6,
  // Predict 1500
  FLIGHT_LOG_FIELD_PREDICTOR_1500 = 8,
  // Predict vbatref, the reference ADC level stored in the header
  FLIGHT_LOG_FIELD_PREDICTOR_VBATREF = 9,
  // Predict the last time value written in the main stream
  FLIGHT_LOG_FIELD_PREDICTOR_LAST_MAIN_FRAME_TIME = 10,
  // Predict that this field is minthrottle
  FLIGHT_LOG_FIELD_PREDICTOR_MINMOTOR = 11,
  FLIGHT_LOG_FIELD_ENCODING_SIGNED_VB = 0, // Signed variable-byte
  FLIGHT_LOG_FIELD_ENCODING_UNSIGNED_VB = 1, // Unsigned variable-byte
  FLIGHT_LOG_FIELD_ENCODING_NEG_14BIT = 3, // Unsigned variable-byte but we negate the value before storing, value is 14 bits
  FLIGHT_LOG_FIELD_ENCODING_TAG8_8SVB = 6,
  FLIGHT_LOG_FIELD_ENCODING_TAG2_3S32 = 7,
  FLIGHT_LOG_FIELD_ENCODING_TAG8_4S16 = 8,
  FLIGHT_LOG_FIELD_ENCODING_NULL = 9, // Nothing is written to the file, take value to be zero
  FLIGHT_LOG_FIELD_ENCODING_TAG2_3SVARIABLE = 10;
