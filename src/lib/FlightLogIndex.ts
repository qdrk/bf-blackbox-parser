import { FlightLogEvent } from "./FlightLogFieldDefs";
import { ArrayDataStream } from "./utils/ArrayDataStream";
import {
  FlightLogParser,
  FLIGHT_LOG_FIELD_INDEX_TIME,
  FLIGHT_LOG_START_MARKER,
} from "./FlightLogParser";

export class FlightLogIndex {
  private logBeginOffsets = null;
  private intraframeDirectories = null;

  constructor(private logData) {}

  _buildIntraframeDirectories() {
    const parser = new FlightLogParser(this.logData);

    this.intraframeDirectories = [];

    for (let i = 0; i < this.getLogCount(); i++) {
      const intraIndex = this._parseSubLog(parser, i);

      this.intraframeDirectories.push(intraIndex);
    }
  }

  private _parseSubLog(parser, subLogIndex) {
    const intraIndex: any = {
      // The beginning time of a new chunk. Every 4th I frame.
      times: [],
      // The beginning offset of a new chunk. Every 4th I frame.
      offsets: [],
      // The average motor outputs.
      avgThrottle: [],

      // Initial slow frame info for each chunk.
      initialSlow: [],

      hasEvent: [],
      minTime: false,
      maxTime: false,
      error: "",
    };
    intraIndex.stats = [];

    let iframeCount = 0,
      motorFields = [],
      throttleTotal,
      parsedHeader,
      sawEndMarker = false;

    try {
      parser.parseHeader(
        this.logBeginOffsets[subLogIndex],
        this.logBeginOffsets[subLogIndex + 1]
      );
      parsedHeader = true;
    } catch (e) {
      console.error(
        "Error parsing header of log #" + (subLogIndex + 1) + ": " + e
      );
      intraIndex.error = e;

      parsedHeader = false;
    }

    // Only attempt to parse the log if the header wasn't corrupt
    if (parsedHeader) {
      const mainFrameDef = parser.frameDefs.I;

      let lastSlow = [];

      // Identify motor fields so they can be used to show the activity summary
      // bar
      for (var j = 0; j < 8; j++) {
        if (mainFrameDef.nameToIndex["motor[" + j + "]"] !== undefined) {
          motorFields.push(mainFrameDef.nameToIndex["motor[" + j + "]"]);
        }
      }

      parser.onFrameReady = function (
        frameValid,
        frame,
        frameType,
        frameOffset,
        _
      ) {
        if (!frameValid) return;

        switch (frameType) {
          case "P":
          case "I":
            const frameTime = frame[FLIGHT_LOG_FIELD_INDEX_TIME];

            if (intraIndex.minTime === false) {
              intraIndex.minTime = frameTime;
            }

            if (
              intraIndex.maxTime === false ||
              frameTime > intraIndex.maxTime
            ) {
              intraIndex.maxTime = frameTime;
            }

            if (frameType == "I") {
              // Start a new chunk on every 4th I-frame
              if (iframeCount % 4 === 0) {
                // Log the beginning of the new chunk
                intraIndex.times.push(frameTime);
                intraIndex.offsets.push(frameOffset);

                if (motorFields.length) {
                  throttleTotal = motorFields.reduce(
                    (total, motorField) => total + frame[motorField],
                    0
                  );

                  intraIndex.avgThrottle.push(
                    Math.round(throttleTotal / motorFields.length)
                  );
                }

                /* To enable seeking to an arbitrary point in the log without
                 * re-reading anything that came before, we have to record
                 * the initial state of various items which aren't logged
                 * a new every iteration.
                 */
                intraIndex.initialSlow.push(lastSlow);
              }

              iframeCount++;
            }

            break;
          case "E":
            // Mark that there was an event inside the current chunk
            if (intraIndex.times.length > 0) {
              intraIndex.hasEvent[intraIndex.times.length - 1] = true;
            }

            if (frame.event == FlightLogEvent.LOG_END) {
              sawEndMarker = true;
            }
            break;
          case "S":
            lastSlow = frame.slice(0);
            break;
        }
      };

      try {
        parser.parseLogData();
      } catch (e) {
        intraIndex.error = e;
      }

      // Don't bother including the initial (empty) states for S and H frames
      // if we didn't have any in the source data
      if (!parser.frameDefs.S) {
        delete intraIndex.initialSlow;
      }

      intraIndex.stats = parser.stats;
    }

    // Did we not find any events in this log?
    if (intraIndex.minTime === false) {
      if (sawEndMarker) {
        intraIndex.error += ": Logging paused, no data";
      } else {
        intraIndex.error += ": Log truncated, no data";
      }
    }

    return intraIndex;
  }

  getLogBeginOffset(index) {
    if (!this.logBeginOffsets) {
      this.buildLogOffsetsIndex();
    }

    return this.logBeginOffsets[index];
  }

  getLogCount() {
    if (!this.logBeginOffsets) {
      this.buildLogOffsetsIndex();
    }

    return this.logBeginOffsets.length - 1;
  }

  _getIntraframeDirectories() {
    if (!this.intraframeDirectories) this._buildIntraframeDirectories();

    return this.intraframeDirectories;
  }

  getIntraframeDirectory(logIndex) {
    return this._getIntraframeDirectories()[logIndex];
  }

  buildLogOffsetsIndex() {
    this.logBeginOffsets = new ArrayDataStream(this.logData).allIndicesOf(
      FLIGHT_LOG_START_MARKER
    );
  }
}
