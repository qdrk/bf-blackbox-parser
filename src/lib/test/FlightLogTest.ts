/**
 Update golden:

 cp ~/.tmp/ds-flightlog-golden/* \
   /src/lib/test/golden

*/

import { expect } from 'chai';
import { promises as fs } from 'fs';
import { FlightLog } from '../FlightLog';
import { allIndicesOf } from './Utils';
import { expectedTimeAndFrame, expectedSmoothedTimeAndFrame } from './TestFrameData';
import { GoldenUtils } from './GoldenUtils';

const TEST_DIR = 'src/lib/test';
const GOLDEN_DIR = `${TEST_DIR}/golden`;

describe('FlightLog', async function () {
  let flightLog; //: FlightLog;

  before(async function () {
    const buffer = new Uint8Array(
      await fs.readFile(`${TEST_DIR}/btfl_005.bbl`));

    flightLog = new FlightLog(buffer);

    flightLog.openLog(0);
  });

  it('should parse start/end time', function () {
    expect(flightLog.getLogCount()).eq(6);

    expect(flightLog.getMinTime(0)).eq(72120701);
    expect(flightLog.getMaxTime(0)).eq(91896785);

    expect(flightLog.getMinTime(3)).eq(232699704);
    expect(flightLog.getMaxTime(3)).eq(239387785);
  });

  it('should return correct stats', async function () {
    const stats = flightLog.getStats();

    const fieldStats =
      flightLog.getMainFieldNames().map((fieldName) => {
        const fieldIndex = flightLog.getMainFieldIndexByName(fieldName);

        return stats.field[fieldIndex];
      });

    const goldenUtils = await GoldenUtils.fromFile(GOLDEN_DIR, 'stats');
    goldenUtils.diff(fieldStats);
    expect(fieldStats).to.deep.equal(goldenUtils.content);
  });

  it('should return correct main field names', function () {
    expect(flightLog.getMainFieldCount()).eq(54);

    const fieldNames = flightLog.getMainFieldNames();
    expect(fieldNames).eql(mainFieldNames);
  });

  it('should return the right indices', function () {
    const mainFieldIndices = mainFieldNames.map(
      (fieldName) => flightLog.getMainFieldIndexByName(fieldName));

    expect(mainFieldIndices).eql([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
      24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
      36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
      48, 49, 50, 51, 52, 53,
    ]);
  });

  it('should parse configs', function () {
    const actualConfigs = flightLog.getSysConfig();

    for (const key in expectedConfigs) {
      expect(expectedConfigs[key]).to.deep.equal(actualConfigs[key]);
    }
  });

  it('should return correct activity summaries', function () {
    const activitySummary = flightLog.getActivitySummary();

    const { times, avgThrottle, hasEvent } = activitySummary;

    expect(times).to.have.length(155);
    expect(avgThrottle).to.have.length(155);
    expect(hasEvent).to.have.length(155);

    const hasEventsTimes = allIndicesOf(hasEvent, true)
      .map((index) => times[index]);
    expect(hasEventsTimes).to.deep.equal([
      72120701,
      91832785,
    ]);

    const selectedIndices = [2, 42, 55, 78, 140];
    const selectedTimes =
      selectedIndices.map((index) => times[index]);
    const selectedThrottle =
      selectedIndices.map((index) => avgThrottle[index]);
    expect(selectedTimes).to.deep.equal([
      72376659,
      77496785,
      79160784,
      82104786,
      90040785,
    ]);
    expect(selectedThrottle).to.deep.equal([
      333,
      505,
      214,
      230,
      593,
    ]);
  });

  it('should return correct frame', async function () {
    for (const { logIndex, frames } of expectedTimeAndFrame) {
      flightLog.openLog(logIndex);

      for (const { time } of frames) {
        const actualFrame = flightLog.getFrameAtTime(time);

        const goldenUtils = await GoldenUtils.fromFile(GOLDEN_DIR, `frame_${logIndex}_${time}`);
        goldenUtils.diff(actualFrame);
        expect(actualFrame).to.deep.equal(goldenUtils.content);
      }
    }
  });

  it('should return right chunk data', async function () {
    const chunks = flightLog.getChunksInTimeRange(72120701);
    expect(chunks).to.have.length(1);
    expect(chunks[0].frames).to.have.length(128);
    // 57 fields.
    expect(chunks[0].frames[0]).to.have.length(54);

    const goldenUtils = await GoldenUtils.fromFile(GOLDEN_DIR, `111frame`);
    goldenUtils.diff(chunks[0].frames[111]);
    expect(chunks[0].frames[111]).to.deep.equal(goldenUtils.content);

    flightLog.openLog(5);

    const moreChunks = flightLog.getChunksInTimeRange(72120701, 91896785);
    expect(moreChunks).to.have.length(1);
    expect(moreChunks[0].frames).to.have.length(128);
  });


  it('should get right events with smoothed chunks', async function () {
    flightLog.openLog(5);

    expect(flightLog.getMinTime()).to.be.equal(381127670);
    expect(flightLog.getMaxTime()).to.be.equal(385799908);

    const chunks = flightLog.getSmoothedChunksInTimeRange(
      flightLog.getMinTime(), flightLog.getMaxTime());

    expect(chunks).to.have.length(37);

    const events = [];
    for (let i = 0; i < chunks.length; i++) {
      for (const event of chunks[i].events) {
        events.push(event);
      }
    }


    const goldenUtils = await GoldenUtils.fromFile(GOLDEN_DIR, `events`);
    goldenUtils.diff(events);
    // expect has to be within the test.
    expect(events).to.deep.equal(goldenUtils.content);
  });


  /**
   * gyroRawToDegreesPerSecond
   * rcMotorRawToPctPhysical
   * rcMotorRawToPctEffective
   * getPIDPercentage
   * accRawToGs
   * getNumCellsEstimate
   * vbatADCToMillivolts
   * amperageADCToMillivolts
   *
   * rcCommandRawToThrottle
   * rcCommandRawToDegreesPerSecond
   * isDigitalProtocol
   */
});

const mainFieldNames = [
  "loopIteration",
  "time",
  "axisP[0]",
  "axisP[1]",
  "axisP[2]",
  "axisI[0]",
  "axisI[1]",
  "axisI[2]",
  "axisD[0]",
  "axisD[1]",
  "axisF[0]",
  "axisF[1]",
  "axisF[2]",
  "rcCommand[0]",
  "rcCommand[1]",
  "rcCommand[2]",
  "rcCommand[3]",
  "setpoint[0]",
  "setpoint[1]",
  "setpoint[2]",
  "setpoint[3]",
  "vbatLatest",
  "amperageLatest",
  "rssi",
  "gyroADC[0]",
  "gyroADC[1]",
  "gyroADC[2]",
  "debug[0]",
  "debug[1]",
  "debug[2]",
  "debug[3]",
  "motor[0]",
  "motor[1]",
  "motor[2]",
  "motor[3]",
  "flightModeFlags",
  "stateFlags",
  "failsafePhase",
  "rxSignalReceived",
  "rxFlightChannelsValid",
  // No more IMUs.
  // "heading[0]",
  // "heading[1]",
  // "heading[2]",
  "axisSum[0]",
  "axisSum[1]",
  "axisSum[2]",
  "rcCommands[0]",
  "rcCommands[1]",
  "rcCommands[2]",
  "rcCommands[3]",
  "axisError[0]",
  "axisError[1]",
  "axisError[2]",
  "motorLegacy[0]",
  "motorLegacy[1]",
  "motorLegacy[2]",
  "motorLegacy[3]"
];

const expectedConfigs = {
  Product: 'Blackbox flight data recorder by Nicholas Sherlock',
  firmwareType: 3,
  firmware: '4.2',
  firmwarePatch: 0,
  firmwareVersion: '4.2.0',
  'Firmware revision': 'Betaflight 4.2.0 (8f2d21460) STM32F405',
  'Firmware date': 'Jun 14 2020 03:04:22',
  'Board information': 'AIRB OMNIBUSF4',
  'Log start datetime': '0000-01-01T00:00:00.000+00:00',
  'Craft name': '',
  frameIntervalI: 256,
  frameIntervalPNum: 1,
  frameIntervalPDenom: 8,
  minthrottle: 1020,
  maxthrottle: 2000,
  gyroScale: 1.7453292519943295e-8,
  motorOutput: [192, 2047],
  acc_1G: 0,
  vbatscale: 110,
  vbatmincellvoltage: 330,
  vbatwarningcellvoltage: 350,
  vbatmaxcellvoltage: 440,
  vbatref: 1665,
  currentMeterOffset: 0,
  currentMeterScale: 400,
  looptime: 125,
  gyro_sync_denom: 1,
  pid_process_denom: 1,
  thrMid: 55,
  thrExpo: 50,
  dynThrPID: 85,
  tpa_breakpoint: 1700,
  rc_rates: [175, 175, 128],
  rc_expo: [47, 47, 4],
  rates: [38, 38, 43],
  rate_limits: [1998, 1998, 1998],
  rollPID: [70, 10, 64, 0],
  pitchPID: [58, 10, 52, 0],
  yawPID: [45, 10, 0, 0],
  levelPID: [50, 50, 75],
  magPID: [40, null, null],
  d_min: [0, 0, 0],
  d_min_gain: 37,
  d_min_advance: 20,
  dterm_filter_type: 0,
  dterm_lpf_hz: 150,
  dterm_lpf_dyn_hz: [70, 170],
  dterm_filter2_type: 0,
  dterm_lpf2_hz: 150,
  yaw_lpf_hz: 0,
  dterm_notch_hz: 0,
  dterm_notch_cutoff: 0,
  itermWindupPointPercent: 100,
  iterm_relax: 1,
  iterm_relax_type: 1,
  iterm_relax_cutoff: 15,
  vbat_pid_compensation: 0,
  pidAtMinThrottle: 1,
  anti_gravity_mode: 0,
  anti_gravity_threshold: 250,
  anti_gravity_gain: 3500,
  abs_control_gain: 0,
  use_integrated_yaw: 0,
  feedforward_transition: 0,
  yawRateAccelLimit: 0,
  rateAccelLimit: 0,
  pidSumLimit: 500,
  pidSumLimitYaw: 400,
  deadband: 0,
  yaw_deadband: 0,
  gyro_lpf: 0,
  gyro_soft_type: 0,
  gyro_lowpass_hz: 0,
  gyro_lowpass_dyn_hz: [0, 700],
  gyro_soft2_type: 0,
  gyro_lowpass2_hz: 180,
  gyro_notch_hz: [0, 0],
  gyro_notch_cutoff: [0, 0],
  dyn_notch_max_hz: 750,
  dyn_notch_width_percent: 0,
  dyn_notch_q: 250,
  dyn_notch_min_hz: 140,
  dshot_bidir: 1,
  gyro_rpm_notch_harmonics: 3,
  gyro_rpm_notch_q: 800,
  gyro_rpm_notch_min: 100,
  dterm_rpm_notch_harmonics: 0,
  dterm_rpm_notch_q: 500,
  dterm_rpm_notch_min: 100,
  acc_lpf_hz: 1000,
  acc_hardware: 1,
  baro_hardware: 1,
  mag_hardware: 1,
  gyro_cal_on_first_arm: 0,
  rc_interpolation: 2,
  rc_interpolation_interval: 19,
  rc_interpolation_channels: 2,
  airmode_activate_throttle: 25,
  serialrx_provider: 12,
  unsynced_fast_pwm: 0,
  fast_pwm_protocol: 7,
  motor_pwm_rate: 480,
  digitalIdleOffset: 720,
  debug_mode: 6,
  features: 809762824,
  rc_smoothing_type: 1,
  rc_smoothing_debug_axis: 0,
  rc_smoothing_cutoffs: [40, 0],
  rc_smoothing_auto_factor: 20,
  rc_smoothing_filter_type: [1, 1],
  rc_smoothing_active_cutoffs: [40, 80],
  rc_smoothing_rx_average: 0,
  rates_type: 0
};

