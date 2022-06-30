import {
  DEBUG_MODE,
  DSHOT_MIN_VALUE,
  DSHOT_RANGE,
  RATES_TYPE,
} from "./FlightLogFieldDefs";

export class GraphConfig {
  private graphs;
  private listeners;

  public selectedFieldName = null;
  public selectedGraphIndex = 0;
  public selectedFieldIndex = 0;

  public highlightGraphIndex = null;
  public highlightFieldIndex = null;

  constructor(graphConfig) {
    this.graphs = graphConfig ?? [];
    this.listeners = [];
  }

  notifyListeners() {
    for (var i = 0; i < this.listeners.length; i++) {
      this.listeners[i](this);
    }
  }

  getGraphs() {
    return this.graphs;
  }

  /**
   * newGraphs is an array of objects like {label: "graph label", height:, fields:[{name: curve:{offset:, power:, inputRange:, outputRange:, steps:}, color:, }, ...]}
   */
  setGraphs(newGraphs) {
    this.graphs = newGraphs;

    this.notifyListeners();
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  public static getDefaultSmoothingForField(flightLog, fieldName) {
    try {
      if (fieldName.match(/^motor(Raw)?\[/)) {
        return 5000;
      } else if (fieldName.match(/^servo\[/)) {
        return 5000;
      } else if (fieldName.match(/^gyroADC.*\[/)) {
        return 3000;
      } else if (fieldName.match(/^accSmooth\[/)) {
        return 3000;
      } else if (fieldName.match(/^axis.+\[/)) {
        return 3000;
      } else {
        return 0;
      }
    } catch (e) {
      return 0;
    }
  }

  public static getDefaultCurveForField(flightLog, fieldName) {
    const sysConfig = flightLog.getSysConfig();

    var maxDegreesSecond = function (scale) {
      switch (sysConfig["rates_type"]) {
        case RATES_TYPE.indexOf("ACTUAL"):
        case RATES_TYPE.indexOf("QUICK"):
          return Math.max(
            sysConfig["rates"][0] * 10.0 * scale,
            sysConfig["rates"][1] * 10.0 * scale,
            sysConfig["rates"][2] * 10.0 * scale
          );
        default:
          return Math.max(
            flightLog.rcCommandRawToDegreesPerSecond(500, 0) * scale,
            flightLog.rcCommandRawToDegreesPerSecond(500, 1) * scale,
            flightLog.rcCommandRawToDegreesPerSecond(500, 2) * scale
          );
      }
    };

    var getMinMaxForFields = function (/* fieldName1, fieldName2, ... */) {
      // helper to make a curve scale based on the combined min/max of one or more fields
      const stats = flightLog.getStats();
      let min = Number.MAX_VALUE,
        max = Number.MIN_VALUE;

      for (var i in arguments) {
        const fieldIndex = flightLog.getMainFieldIndexByName(arguments[i]),
          fieldStat =
            fieldIndex !== undefined ? stats.field[fieldIndex] : false;

        if (fieldStat) {
          min = Math.min(min, fieldStat.min);
          max = Math.max(max, fieldStat.max);
        }
      }

      if (min != Number.MAX_VALUE && max != Number.MIN_VALUE) {
        return { min: min, max: max };
      }

      return { min: -500, max: 500 };
    };

    var getCurveForMinMaxFields = function (
      ...args: any[] /* fieldName1, fieldName2, ... */
    ) {
      var mm = getMinMaxForFields.apply(null, args);

      return {
        offset: -(mm.max + mm.min) / 2,
        power: 1.0,
        inputRange: Math.max((mm.max - mm.min) / 2, 1.0),
        outputRange: 1.0,
      };
    };

    var getCurveForMinMaxFieldsZeroOffset = function (
      ...args: any[] /* fieldName1, fieldName2, ... */
    ) {
      var mm = getMinMaxForFields.apply(null, args);

      return {
        offset: 0,
        power: 1.0,
        inputRange: Math.max(Math.max(Math.abs(mm.max), Math.abs(mm.min)), 1.0),
        outputRange: 1.0,
      };
    };

    const gyroScaleMargin = 1.1; // Give a 10% margin for gyro graphs

    try {
      if (fieldName.match(/^motor\[/)) {
        return {
          offset: flightLog.isDigitalProtocol()
            ? -(DSHOT_MIN_VALUE + DSHOT_RANGE / 2)
            : -(
                sysConfig.minthrottle +
                (sysConfig.maxthrottle - sysConfig.minthrottle) / 2
              ),
          power: 1.0,
          inputRange: flightLog.isDigitalProtocol()
            ? DSHOT_RANGE / 2
            : (sysConfig.maxthrottle - sysConfig.minthrottle) / 2,
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^motorLegacy\[/)) {
        return {
          offset: -(sysConfig.motorOutput[1] + sysConfig.motorOutput[0]) / 2,
          power: 1.0,
          inputRange: (sysConfig.motorOutput[1] - sysConfig.motorOutput[0]) / 2,
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^servo\[/)) {
        return {
          offset: -1500,
          power: 1.0,
          inputRange: 500,
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^accSmooth\[/)) {
        return {
          offset: 0,
          power: 0.5,
          inputRange:
            sysConfig.acc_1G * 16.0 /* Reasonable typical maximum for acc */,
          outputRange: 1.0,
        };
      } else if (fieldName == "rcCommands[3]") {
        // Throttle scaled
        return {
          offset: -50,
          power: 1.0 /* Make this 1.0 to scale linearly */,
          inputRange: 50,
          outputRange: 1.0,
        };
      } else if (
        fieldName.match(/^axisError\[/) || // Gyro, Gyro Scaled, RC Command Scaled and axisError
        fieldName.match(/^rcCommands\[/) || // These use the same scaling as they are in the
        fieldName.match(/^gyroADC\[/)
      ) {
        // same range.
        return {
          offset: 0,
          power: 0.25 /* Make this 1.0 to scale linearly */,
          inputRange: maxDegreesSecond(gyroScaleMargin), // Maximum grad/s + 20%
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^axis.+\[/)) {
        return {
          offset: 0,
          power: 0.3,
          inputRange: 1000, // Was 400 ?
          outputRange: 1.0,
        };
      } else if (fieldName == "rcCommand[3]") {
        // Throttle
        return {
          offset: -1500,
          power: 1.0,
          inputRange: 500,
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^rcCommand\[/)) {
        return {
          offset: 0,
          power: 0.25,
          inputRange: 500 * gyroScaleMargin, // +20% to let compare in the same scale with the rccommands
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^sonar.*/)) {
        return {
          offset: -200,
          power: 1.0,
          inputRange: 200,
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^rssi.*/)) {
        return {
          offset: -512,
          power: 1.0,
          inputRange: 512,
          outputRange: 1.0,
        };
      } else if (fieldName.match(/^debug.*/) && sysConfig.debug_mode != null) {
        var debugModeName = DEBUG_MODE[sysConfig.debug_mode];
        switch (debugModeName) {
          case "CYCLETIME":
            switch (fieldName) {
              case "debug[1]": //CPU Load
                return {
                  offset: -50,
                  power: 1,
                  inputRange: 50,
                  outputRange: 1.0,
                };
              default:
                return {
                  offset: -1000, // zero offset
                  power: 1.0,
                  inputRange: 1000, //  0-2000uS
                  outputRange: 1.0,
                };
            }
          case "PIDLOOP":
            return {
              offset: -250, // zero offset
              power: 1.0,
              inputRange: 250, //  0-500uS
              outputRange: 1.0,
            };
          case "GYRO":
          case "GYRO_FILTERED":
          case "GYRO_SCALED":
          case "DUAL_GYRO":
          case "DUAL_GYRO_COMBINED":
          case "DUAL_GYRO_DIFF":
          case "DUAL_GYRO_RAW":
          case "NOTCH":
          case "AC_CORRECTION":
          case "AC_ERROR":
            return {
              offset: 0,
              power: 0.25,
              inputRange: maxDegreesSecond(gyroScaleMargin), // Maximum grad/s + 20%
              outputRange: 1.0,
            };
          case "ACCELEROMETER":
            return {
              offset: 0,
              power: 0.5,
              inputRange:
                sysConfig.acc_1G *
                16.0 /* Reasonable typical maximum for acc */,
              outputRange: 1.0,
            };
          case "MIXER":
            return {
              offset:
                -(sysConfig.motorOutput[1] + sysConfig.motorOutput[0]) / 2,
              power: 1.0,
              inputRange:
                (sysConfig.motorOutput[1] - sysConfig.motorOutput[0]) / 2,
              outputRange: 1.0,
            };
          case "BATTERY":
            switch (fieldName) {
              case "debug[0]": //Raw Value (0-4095)
                return {
                  offset: -2048,
                  power: 1,
                  inputRange: 2048,
                  outputRange: 1.0,
                };
              default:
                return {
                  offset: -130,
                  power: 1.0,
                  inputRange: 130, // 0-26.0v
                  outputRange: 1.0,
                };
            }
          case "RC_INTERPOLATION":
            switch (fieldName) {
              case "debug[0]": // Roll RC Command
              case "debug[3]": // refresh period
                return getCurveForMinMaxFieldsZeroOffset(fieldName);
            }
            break;
          case "RC_SMOOTHING":
            switch (fieldName) {
              case "debug[0]": // raw RC command
                return {
                  offset: 0,
                  power: 0.25,
                  inputRange: 500 * gyroScaleMargin, // +20% to let compare in the same scale with the rccommands
                  outputRange: 1.0,
                };
              case "debug[1]": // raw RC command derivative
              case "debug[2]": // smoothed RC command derivative
                return getCurveForMinMaxFieldsZeroOffset(
                  "debug[1]",
                  "debug[2]"
                );
            }
            break;
          case "RC_SMOOTHING_RATE":
            switch (fieldName) {
              case "debug[0]": // current frame rate [us]
              case "debug[2]": // average frame rate [us]
                return getCurveForMinMaxFields("debug[0]", "debug[2]");
            }
            break;
          case "ANGLERATE":
            return {
              offset: 0,
              power: 0.25 /* Make this 1.0 to scale linearly */,
              inputRange: maxDegreesSecond(gyroScaleMargin), // Maximum grad/s + 20%
              outputRange: 1.0,
            };
          case "FFT":
            switch (fieldName) {
              case "debug[0]": // gyro scaled [for selected axis]
              case "debug[1]": // pre-dyn notch gyro [for selected axis]
              case "debug[2]": // pre-dyn notch gyro FFT downsampled [roll]
                return {
                  offset: 0,
                  power: 0.25,
                  inputRange: maxDegreesSecond(gyroScaleMargin), // Maximum grad/s + 20%
                  outputRange: 1.0,
                };
            }
            break;
          case "FFT_FREQ":
            switch (fieldName) {
              case "debug[0]": // roll center freq
              case "debug[1]": // pitch center freq
                return getCurveForMinMaxFields("debug[0]", "debug[1]");
              case "debug[2]": // pre-dyn notch gyro [for selected axis]
              case "debug[3]": // raw gyro [for selected axis]
                return {
                  offset: 0,
                  power: 0.25,
                  inputRange: maxDegreesSecond(gyroScaleMargin), // Maximum grad/s + 20%
                  outputRange: 1.0,
                };
            }
            break;
          case "DYN_LPF":
            switch (fieldName) {
              case "debug[1]": // Notch center
              case "debug[2]": // Lowpass Cutoff
                return getCurveForMinMaxFields("debug[1]", "debug[2]");
              case "debug[0]": // gyro scaled [for selected axis]
              case "debug[3]": // pre-dyn notch gyro [for selected axis]
                return {
                  offset: 0,
                  power: 0.25,
                  inputRange: maxDegreesSecond(gyroScaleMargin), // Maximum grad/s + 20%
                  outputRange: 1.0,
                };
            }
            break;
          case "FFT_TIME":
            return {
              offset: 0,
              power: 1.0,
              inputRange: 100,
              outputRange: 1.0,
            };
          case "ESC_SENSOR_RPM":
          case "DSHOT_RPM_TELEMETRY":
          case "RPM_FILTER":
            return getCurveForMinMaxFields(
              "debug[0]",
              "debug[1]",
              "debug[2]",
              "debug[3]"
            );
          case "D_MIN":
            switch (fieldName) {
              case "debug[0]": // roll gyro factor
              case "debug[1]": // roll setpoint Factor
                return getCurveForMinMaxFields("debug[0]", "debug[1]");
              case "debug[2]": // roll actual D
              case "debug[3]": // pitch actual D
                return getCurveForMinMaxFields("debug[2]", "debug[3]");
            }
            break;
          case "ITERM_RELAX":
            switch (fieldName) {
              case "debug[2]": // roll I relaxed error
              case "debug[3]": // roll absolute control axis error
                return getCurveForMinMaxFieldsZeroOffset(fieldName);
            }
            break;
        }
      }
      // if not found above then
      // Scale and center the field based on the whole-log observed ranges for that field
      return getCurveForMinMaxFields(fieldName);
    } catch (e) {
      console.warn(e);

      return {
        offset: 0,
        power: 1.0,
        inputRange: 500,
        outputRange: 1.0,
      };
    }
  }
}
