import { SemVer } from "semver";
import {
  FIRMWARE_TYPE_BETAFLIGHT,
  FIRMWARE_TYPE_CLEANFLIGHT,
} from "../configs/FirmwareTypes";
import { FLIGHT_LOG_FIELD_INDEX_TIME } from "../FlightLogParser";

export function smoothArray(arr, windowSize = 10) {
  const gen = smoothed(arr, (i) => i, windowSize);
  const result = [];
  while (true) {
    const node = gen.next();

    if (node.done) {
      break;
    }

    result.push(node.value);
  }

  return result;
}

/// Smooth a single using window-average.
export function* smoothed(arr, getter, windowSize = 10) {
  let i = 0;
  let currentWindowSize = 0;
  let currentWindowSum = 0;

  while (i < arr.length) {
    currentWindowSum += getter(arr[i]);
    currentWindowSize += 1;

    if (currentWindowSize > windowSize) {
      if (currentWindowSize != windowSize + 1) throw "window size miss match.";

      currentWindowSum -= getter(arr[i - windowSize]);
      currentWindowSize -= 1;
    }

    yield currentWindowSum / currentWindowSize;
    i += 1;
  }
}

export function expand(arr, fn) {
  const result = [];
  for (const items of arr) {
    for (const item of fn(items)) {
      result.push(item);
    }
  }

  return result;
}

export function constrain(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

export function formatTime(msec, displayMsec) {
  // modify function to allow negative times.
  var ms, secs, mins, hours;

  ms = Math.round(Math.abs(msec));

  secs = Math.floor(ms / 1000);
  ms %= 1000;

  mins = Math.floor(secs / 60);
  secs %= 60;

  hours = Math.floor(mins / 60);
  mins %= 60;

  return (
    (msec < 0 ? "-" : "") +
    (hours ? leftPad(hours, "0", 2) + ":" : "") +
    leftPad(mins, "0", 2) +
    ":" +
    leftPad(secs, "0", 2) +
    (displayMsec ? "." + leftPad(ms, "0", 3) : "")
  );
}

function leftPad(string, pad, minLength) {
  string = "" + string;

  while (string.length < minLength) string = pad + string;

  return string;
}

export function signExtend24Bit(u) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return u & 0x800000 ? u | 0xff000000 : u;
}

export function signExtend16Bit(word) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return word & 0x8000 ? word | 0xffff0000 : word;
}

export function signExtend14Bit(word) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return word & 0x2000 ? word | 0xffffc000 : word;
}

export function signExtend8Bit(byte) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return byte & 0x80 ? byte | 0xffffff00 : byte;
}

export function signExtend7Bit(byte) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return byte & 0x40 ? byte | 0xffffff80 : byte;
}

export function signExtend6Bit(byte) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return byte & 0x20 ? byte | 0xffffffc0 : byte;
}

export function signExtend5Bit(byte) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return byte & 0x10 ? byte | 0xffffffe0 : byte;
}

export function signExtend4Bit(nibble) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return nibble & 0x08 ? nibble | 0xfffffff0 : nibble;
}

export function signExtend2Bit(byte) {
  //If sign bit is set, fill the top bits with 1s to sign-extend
  return byte & 0x02 ? byte | 0xfffffffc : byte;
}

export function uint32ToFloat(value) {
  var arr = new Uint32Array(1);
  arr[0] = value;

  var floatArr = new Float32Array(arr.buffer);

  return floatArr[0];
}

export function stringHasComma(string) {
  /***
   * Checks if the string contains at least one comma.
   *
   * string               is the string to check
   *
   * returns              true if at least one comma is found.
   *                      false if no comma is found.
   ***/
  return string.match(/.*,.*/) != null;
}

export function parseCommaSeparatedString(string, length = 0) {
  /***
   * Parse a comma separated string for individual values.
   *
   * string               is the comma separated string to parse
   * length (optional)    the returned array will be forced to be this long; extra fields will be discarded,
   *                      missing fields will be padded. if length is not specified, then array will be auto
   *                      sized.
   *
   * returns              if the string does not contain a comma, then the first integer/float/string is returned
   *                      else an Array is returned containing all the values up to the length (if specified)
   ***/
  var parts = string.split(","),
    result,
    value;

  length = length || parts.length; // we can force a length if we like

  if (length < 2) {
    // this is not actually a list, just return the value
    value = parts.indexOf(".") ? parseFloat(parts) : parseInt(parts, 10);
    return isNaN(value) ? string : value;
  } else {
    // this really is a list; build an array
    result = new Array(length);
    for (var i = 0; i < length; i++) {
      if (i < parts.length) {
        value = parts[i].indexOf(".")
          ? parseFloat(parts[i])
          : parseInt(parts[i], 10);
        result[i] = isNaN(value) ? parts[i] : value;
      } else {
        result[i] = null;
      }
    }
    return result;
  }
}

export function hexToFloat(string) {
  var arr = new Uint32Array(1);
  arr[0] = parseInt(string, 16);

  var floatArr = new Float32Array(arr.buffer);

  return floatArr[0];
}

export function semverGte(v1, v2) {
  return new SemVer(v1).compare(v2) >= 0;
}

export function firmwareGreaterOrEqual(sysConfig, bf_version, cf_version) {
  /***
   * Check if firmware version is higher or equal to requested version
   *
   * sysConfig            System config structure
   * bf_version           Betaflight version to check, e.g. '3.1.0' (string)
   * cf_version           Cleanflight version to check, e.g. '2.3.0' (optional, string)
   *
   * returns              True when firmware version is higher or equal to requested version
   *                      False when firmware version is lower than the requested version
   ***/
  if (cf_version === undefined) {
    return (
      sysConfig.firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
      semverGte(sysConfig.firmwareVersion, bf_version)
    );
  } else {
    return (
      (sysConfig.firmwareType == FIRMWARE_TYPE_BETAFLIGHT &&
        semverGte(sysConfig.firmwareVersion, bf_version)) ||
      (sysConfig.firmwareType == FIRMWARE_TYPE_CLEANFLIGHT &&
        semverGte(sysConfig.firmwareVersion, cf_version))
    );
  }
}

export function firstIndexLargerThanTime(frames, time) {
  let low = 0,
    high = frames.length;

  // Use binary search to find the first frame that ">" startTime.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (frames[mid][FLIGHT_LOG_FIELD_INDEX_TIME] <= time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Find the index of `item` in `list`, or if `item` is not contained in `list` then return the index
 * of the next-smaller element (or 0 if `item` is smaller than all values in `list`).
 **/
export function binarySearchOrPrevious(list, item) {
  var min = 0,
    max = list.length,
    mid,
    result = 0;

  while (min < max) {
    mid = Math.floor((min + max) / 2);

    if (list[mid] === item) return mid;
    else if (list[mid] < item) {
      // This might be the largest element smaller than item, but we have to continue the search right to find out
      result = mid;
      min = mid + 1;
    } else max = mid;
  }

  return result;
}

/**
 * Find the index of `item` in `list`, or if `item` is not contained in `list` then return the index
 * of the next-larger element (or the index of the last item if `item` is larger than all values in `list`).
 */
export function binarySearchOrNext(list, item) {
  var min = 0,
    max = list.length,
    mid,
    result = list.length - 1;

  while (min < max) {
    mid = Math.floor((min + max) / 2);

    if (list[mid] === item) return mid;
    else if (list[mid] > item) {
      // This might be the smallest element larger than item, but we have to continue the search left to find out
      max = mid;
      result = mid;
    } else min = mid + 1;
  }

  return result;
}
