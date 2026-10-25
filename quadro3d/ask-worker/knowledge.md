# Quadro knowledge guide

This guide sums up how the Co Print Quadro's software works. The complete source of Co Print's own Klipper modules and
the printer's configuration and macros follow it; when a question goes deeper than the guide, read the code below and
answer from it.

## Machine layout
- Four toolheads T0..T3, each on its own X carriage (carriage_t0..carriage_t3) on one shared X beam. Klipper's
  generic_cartesian kinematics with dual_carriage groups drives them; one carriage is "primary" (the active tool) at a
  time, the others can be moved with SET_DUAL_CARRIAGE / the parallel move module.
- Y moves the bed (shared by all tools), Z moves the X beam.
- Qdock: three parking slots at each end of the beam. Park positions in printer X: left -169, -112.75, -56.5 and right
  356.5, 412.75, 469. Carriages must keep at least 56.25 mm between neighbours (min_clearance).
- Each Qdock slot has a spring-loaded silicone nozzle closer (cap) that a parked nozzle presses down.
- A load cell under a pin in the bed ("bed pin") measures contact force; it is used for tool offset calibration,
  the axis slip test and pressure advance work. Each toolhead also has its own ADXL345 accelerometer (t0..t3).
- Per-toolhead "chroma head" MCUs and LED strips (coprint_leds) show tool state.

## Toolchange (macros + quadro_parallel_carriage)
- T0..T3 are macros (tool_map.cfg). TOOL_MAP maps a logical tool to a physical one (SET_TOOL_MAP), then
  PHYS_TOOL_n runs. PHYS_TOOL_n picks the change macro by the current tool: e.g. from T3 to T1 runs "three_T1"
  (names are <current>_T<new>: zero_T1, one_T0, two_T3, three_T1 ...). Extra parameters such as X=250 Y=150 are passed
  through ({rawparams}), so "T1 X=250" changes to T1 and sends it to X=250.
- A change macro (e.g. three_T1): SET_VELOCITY_LIMIT ACCEL=7000, Z hop (G91 G1 Z0.4), clear the G-code XY offset,
  retract 0.8 mm if the old nozzle is hot (>= 190 C); then one QUADRO_PARALLEL_MOVE moves every carriage that has to
  change place (the departing tool and any in the way go to their Qdock slots, the arriving tool to the requested X/Y
  plus its bed pin offset) with Z = start + 3 mm, SPEED=350, ARRIVING=Tn. Without X it only parks the others. After
  the move: un-retract, SET_DUAL_CARRIAGE CARRIAGE=carriage_tn MODE=PRIMARY, BED_PIN_APPLY_OFFSET TOOL=Tn,
  ACTIVATE_EXTRUDER, sync the part fan, restore the previous accel. During prints the slicer then purges the new tool
  on the prime tower.
- QUADRO_PARALLEL_MOVE T0= T1= T2= T3= [Y=] [Z=] [SPEED=] [ARRIVING=Tn] [MIN_CLEARANCE=] [PLAN_ONLY=1]:
  checks targets against carriage limits and the clearance between neighbours at start and target.
  Without ARRIVING it is one linear move scaled so all carriages arrive together.
  With ARRIVING it uses the delayed-arrival planner: each axis (every carriage, Y, Z) gets its own trapezoidal
  profile at SPEED/accel; T = the longest of them; the arriving tool's own move is delayed by T minus its travel
  time, so it starts late and finishes exactly with the slowest axis while the others clear the way. It prints
  "// QUADRO delayed plan: ARRIVING=T0 delay=0.752143s finish=1.390714s speed=350.000 accel=7000.000":
  delay = how long the arriving tool waits, finish = total move time. delay=0 means the arriving tool has the longest
  trip. PLAN_ONLY=1 prints the per-axis plan (start, target, delay, duration, peak speed) without moving.

## Bed pin calibration (bed_pin_calibration)
Measures each tool's nozzle position against the bed pin with the load cell, giving X/Y/Z offsets relative to T0.
- One cycle: go above the pin at the stored approach point (TOP_X/TOP_Y), tare the load cell, probe Z down
  (coarse steps of COARSE_STEP until force >= THRESHOLD grams, retract RETRACT mm, tare, fine steps of Z_STEP)
  -> pin top Z. Then drop to side height (Z minus side_z_margin) and touch the pin from LEFT, RIGHT, FRONT and BACK
  the same coarse/fine way; CENTER_X = mean of left/right, CENTER_Y = mean of front/back.
- BED_PIN_CALIBRATE_TOOL TOOL=Tn: by default 2 cycles (FIRST=1: 3 cycles, compares the last two; CYCLES=1: one
  cycle, no comparison). It reports each cycle and a COMPARE line with DELTA_X/Y/Z; PASS when every delta is within
  the consistency tolerance, then the result is committed (approach point updated, tool positions saved).
  FAIL ("INCONSISTENT" or "CONTACT_FAIL") parks the tool for cleaning (BED_PIN_PARK_FOR_CLEAN) and sets
  CALIBRATION_STATUS so the screen wizard can ask to clean the nozzle and retry (RETRY=1).
- BED_PIN_CALIBRATE_ALL: all four tools one cycle each. BED_PIN_SAVE_OFFSETS computes offsets vs T0 and writes
  bed_pin_offsets.json; BED_PIN_LOAD_OFFSETS / BED_PIN_APPLY_OFFSET TOOL=Tn load and apply them (toolchange macros
  apply them via gcode offsets).
- Parameters: THRESHOLD (g, default 25), XY_STEP / Z_STEP (fine step, 0.01 mm), SPEED / Z_SPEED, COARSE_STEP (0.2),
  COARSE_SPEED, Z_COARSE_SPEED, RETRACT (1 mm), MAX_DISTANCE (12 mm), Z_MAX_DISTANCE (5 mm), SIDE_Z, and approach
  overrides TOP_X, TOP_Y, LEFT_X, RIGHT_X, FRONT_Y, BACK_Y, SIDE_Z_MARGIN.

## Axis slip test (axis_slip_test)
Detects lost steps (belt/motor slip) on X or Y at a given acceleration.
- AXIS_SLIP_TEST AXIS=X|Y TOOL=Tn ACCEL=7000 VELOCITY=300 [REPEAT] [MIN] [MAX] [TOLERANCE] [PROBE_ONLY=1]:
  needs G28 and an idle printer. It finds the pin's side height, touches the pin once (Y from the front, X from the
  left) for a REFERENCE position, runs a burst on that axis between MIN and MAX at the requested ACCEL/VELOCITY,
  touches again and prints "ACCEL= VEL= BEFORE= AFTER= DIFF= STEP_DIFF= TOL= -> OK|SLIP". DIFF = after - reference,
  STEP_DIFF = after - previous stage. |DIFF| above TOLERANCE (0.15 mm) = SLIP. A positive diff means the axis ended up
  short in the + direction. cycle_distance (0.8 mm) is the length of 4 full motor steps, the size of a typical
  belt-skip jump. On slip the axis can be marked unhomed (unhome_on_slip). If the axis slipped so far that the nozzle lands
  on top of the pin or finds no contact, it stops with "slip too large".
- The burst has 5 sections: high-accel takeoffs after pauses; slow-to-fast transitions in one direction; low-accel
  move then high-accel reversal; short strokes with frequent reversals; mixed short and long moves.
- AXIS_SLIP_SWEEP AXIS=Y START=4000 END=12000 STEP=1000 VELOCITY=300 raises ACCEL stage by stage until the axis slips,
  which shows the safe acceleration limit. PROBE_ONLY=1 REPEAT=3 repeats touches without a burst (measures the
  probing repeatability itself).

## Bed mesh (quadro_bed_mesh)
QUADRO_CUSTOM_BED_MESH [PROFILE=default] [REPEATS=2]: runs complete probing passes over Klipper's configured mesh
(e.g. 9x9), averages every point across the passes, and builds one Klipper mesh from the averages (less noise than a
single pass). QUADRO_BED_MESH_CALIBRATE / CALIBRATE_BED_MESH macros wrap it with homing and heating.

## Input shaper (quadro_input_shaper)
QUADRO_SHAPER_CALIBRATE measures resonances per carriage with each toolhead's own ADXL345 by reusing Klipper's
resonance tester and shaper calibration. X is measured on every carriage (each has its own mass); Y is shared by all
tools, so it is measured once on the first carriage. Results go under [quadro_input_shaper] (shaper_type_x_<carriage>,
shaper_freq_x_<carriage>, shaper_type_y / shaper_freq_y) because stock [input_shaper] cannot hold per-carriage values
with dual_carriage; the right shaper is applied when a tool becomes active. SAVE_CONFIG stores the result.

## Pressure advance with the load cell (pa_autotune, PA_CALIBRATE_LOADCELL)
Extrudes at the purge position at three flow rates for several passes while reading the bed pin load cell, fits how
the extrusion force builds up and derives a pressure advance K. The module notes its conversion constant is still being
tuned, so treat its K as experimental.

## LEDs (coprint_leds)
Toolhead LED animations run on Klipper reactor timers, outside the G-code queue, so they keep animating while macros
wait (M400, TEMPERATURE_WAIT). Commands: TH_SET_FILAMENT LED_NAME= HEX= (filament colour), TH_CLEAR_FILAMENT,
TH_LOADING_START / TH_LOADING_END, PRINT_STATE_START / PRINT_STATE_TOOLCHANGE EXTRUDER_INDEX= / PRINT_STATE_END,
START_WHITE_WAVE / STOP_WHITE_WAVE.

## Load cell probe (load_cell_probe, modified Klipper module)
Klipper's load cell probe with Co Print changes; the bed pin is a load cell (LOAD_CELL=bed_pin) used with
LOAD_CELL_TARE and force readings in grams.

## Printing flow (macros)
START_PRINT homes (QUADRO_HOME / _PRINT_HOME), heats the bed and the tools used, loads the bed mesh, purges new
filaments, and selects the first tool. PAUSE parks the toolhead, RESUME restores it, CANCEL_PRINT parks and turns
heaters off, END_PRINT parks and cools down. Homing order for X carriages: 0, 1, 3, 2 (QUADRO_DISTRIBUTE_X places them).
The calibration wizard (CALIBRATE_HOMING, CALIBRATE_LEVELING, CALIBRATE_FIRST_LEVELING, CALIBRATE_BED_MESH,
CALIBRATE_INPUT_SHAPING) drives these from the printer's screen.

## About this page's simulation
The console runs this configuration and these macros in a browser simulation of Klipper. Motion, homing, toolchanges,
heaters and the bed mesh are simulated. The load cell and accelerometers are not: the slip test's DIFF is always 0 in
the simulation, bed pin results come from the printer's stored calibration files, and shaper results from saved config
values. On the real printer these come from real measurements.

# Source: Co Print Klipper modules (klippy/extras)

## quadro_parallel_carriage.py
```python
# Parallel carriage movement helper for Co Print Quadro
#
# Moves multiple X carriages different distances simultaneously
# using Klipper's DualCarriages scaling system.
#
# Optional Y and Z targets can be included in the SAME coordinated move.

import copy

# Quadro delayed-arrival trajectory planner.
# Pure calculation only: does not command motors or alter printer state.
# Compatible with Python 3.8+. No third-party dependencies.
import math
from dataclasses import dataclass, replace

TOOLS = ('T0', 'T1', 'T2', 'T3')

@dataclass(frozen=True)
class Profile:
    start: float
    target: float
    accel: float
    peak_speed: float
    accel_time: float
    cruise_time: float
    delay: float = 0.

    @property
    def duration(self):
        return 2. * self.accel_time + self.cruise_time

    @property
    def end_time(self):
        return self.delay + self.duration

    @property
    def distance(self):
        return abs(self.target - self.start)

    def state(self, time):
        """Nominal position, velocity and acceleration at relative time."""
        u = time - self.delay
        sign = 1. if self.target > self.start else -1.
        if not self.distance or u <= 0.:
            return self.start, 0., 0.
        if u < self.accel_time:
            return (self.start + sign * self.accel * u*u / 2.,
                    sign * self.accel * u, sign * self.accel)
        if u < self.accel_time + self.cruise_time:
            distance = (self.peak_speed * self.accel_time / 2.
                        + self.peak_speed * (u - self.accel_time))
            return self.start + sign * distance, sign * self.peak_speed, 0.
        if u < self.duration:
            remaining = self.duration - u
            return (self.target - sign * self.accel * remaining**2 / 2.,
                    sign * self.accel * remaining, -sign * self.accel)
        return self.target, 0., 0.

    def boundaries(self):
        return (self.delay, self.delay + self.accel_time,
                self.delay + self.accel_time + self.cruise_time,
                self.end_time)

@dataclass(frozen=True)
class GapMinimum:
    left: str
    right: str
    clearance: float
    time: float

@dataclass(frozen=True)
class Plan:
    profiles: dict
    finish_time: float
    arriving: str
    minimum_gaps: tuple

    def summary(self):
        return {
            'arriving': self.arriving,
            'finish_time': self.finish_time,
            'profiles': {name: {
                'start': p.start, 'target': p.target,
                'delay': p.delay, 'duration': p.duration,
                'end_time': p.end_time, 'peak_speed': p.peak_speed,
                'accel': p.accel,
            } for name, p in self.profiles.items()},
            'minimum_gaps': [dict(left=g.left, right=g.right,
                                 clearance=g.clearance, time=g.time)
                             for g in self.minimum_gaps],
        }

class PlanError(ValueError):
    pass


def finite(value, name, positive=False):
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise PlanError('%s must be a number' % name)
    if not math.isfinite(value) or (positive and value <= 0.):
        raise PlanError('%s must be finite%s' %
                        (name, ' and positive' if positive else ''))
    return value


def make_profile(start, target, speed, accel):
    start = finite(start, 'start')
    target = finite(target, 'target')
    speed = finite(speed, 'speed', True)
    accel = finite(accel, 'accel', True)
    distance = abs(target - start)
    peak = min(speed, math.sqrt(distance * accel))
    ta = peak / accel
    tc = max(0., distance / peak - ta) if peak else 0.
    return Profile(start, target, accel, peak, ta, tc)


def minimum_gap(left_name, left, right_name, right, finish):
    # On every phase interval, relative position is quadratic. Its minimum
    # is at an endpoint or a zero of relative velocity. No temporal sampling.
    points = sorted(set((0., finish) + left.boundaries() + right.boundaries()))
    candidates = list(points)
    for t0, t1 in zip(points, points[1:]):
        mid = (t0 + t1) * .5
        _, lv, la = left.state(mid)
        _, rv, ra = right.state(mid)
        relative_accel = ra - la
        if relative_accel:
            root = mid - (rv - lv) / relative_accel
            if t0 < root < t1:
                candidates.append(root)
    gap, when = min((right.state(t)[0] - left.state(t)[0], t)
                    for t in candidates)
    return GapMinimum(left_name, right_name, gap, when)


def make_plan(starts, targets, arriving, speed, accel, clearance=56.25,
              axis_ranges=None, shared=None):
    """Plan method B. All starts/targets are PHYSICAL coordinates.

    All four X starts must be provided; unspecified targets hold position.
    ARRIVING is supplied by the toolchange macro, never guessed.
    Shared entries: {axis: (start, target, effective_speed, effective_accel)}.
    Effective limits must already include the printer's velocity/axis caps.
    Shared axes start immediately; only ARRIVING has delayed start.
    axis_ranges, when provided, must contain every planned axis/tool.
    Shaping, bed mesh, G-code offsets, minimum_cruise_ratio and motor step
    quantization are deliberately NOT modeled by this nominal planner.
    """
    if arriving not in TOOLS:
        raise PlanError('ARRIVING must be T0, T1, T2 or T3')
    if set(starts) != set(TOOLS):
        raise PlanError('Exactly four physical X start positions required')
    if set(targets) - set(TOOLS):
        raise PlanError('Unknown X target')
    if arriving not in targets:
        raise PlanError('ARRIVING must have an explicit target')
    speed = finite(speed, 'speed', True)
    accel = finite(accel, 'accel', True)
    clearance = finite(clearance, 'clearance')
    if clearance < 0.:
        raise PlanError('clearance cannot be negative')
    profiles = {k: make_profile(starts[k], targets.get(k, starts[k]),
                                speed, accel) for k in TOOLS}
    for axis, args in (shared or {}).items():
        if axis not in ('Y', 'Z'):
            raise PlanError('Only Y and Z are shared axes')
        profiles[axis] = make_profile(*args)
    if axis_ranges is not None:
        for k, p in profiles.items():
            if k not in axis_ranges:
                raise PlanError('Missing axis range for %s' % k)
            lo, hi = (finite(v, k + ' range') for v in axis_ranges[k])
            if lo > hi:
                raise PlanError('Invalid axis range for %s' % k)
            if not lo <= p.start <= hi or not lo <= p.target <= hi:
                raise PlanError('%s start/target outside axis range' % k)
    eps = 1.e-6
    for phase in ('start', 'target'):
        for left, right in zip(TOOLS, TOOLS[1:]):
            gap = getattr(profiles[right], phase) - getattr(profiles[left], phase)
            if gap < clearance - eps:
                raise PlanError('%s clearance %s/%s: %.6f < %.6f' %
                                (phase.upper(), left, right, gap, clearance))
    finish = max(p.duration for p in profiles.values())
    p = profiles[arriving]
    # A stationary arriving carriage has no departure to delay.
    if p.distance:
        profiles[arriving] = replace(p, delay=max(0., finish - p.duration))
    gaps = tuple(minimum_gap(l, profiles[l], r, profiles[r], finish)
                 for l, r in zip(TOOLS, TOOLS[1:]))
    for gap in gaps:
        if gap.clearance < clearance - eps:
            raise PlanError('PATH clearance %s/%s: %.6f < %.6f at %.6fs' %
                            (gap.left, gap.right, gap.clearance,
                             clearance, gap.time))
    return Plan(profiles, finish, arriving, gaps)



class QuadroParallelCarriage:
    TOOL_NAMES = {
        "T0": "carriage_t0",
        "T1": "carriage_t1",
        "T2": "carriage_t2",
        "T3": "carriage_t3",
    }

    PHYSICAL_ORDER = [
        "carriage_t0",
        "carriage_t1",
        "carriage_t2",
        "carriage_t3",
    ]

    def __init__(self, config):
        self.printer = config.get_printer()
        self._delayed_queues = None
        self.toolchange_accel = config.getfloat("toolchange_accel", 10000., above=0.)

        self.default_speed = config.getfloat(
            "default_speed", 50.0, above=0.0
        )

        self.min_clearance = config.getfloat(
            "min_clearance", 56.25, minval=0.0
        )

        gcode = self.printer.lookup_object("gcode")
        gcode.register_command("QUADRO_RUN_TOOLCHANGE",
                               self.cmd_QUADRO_RUN_TOOLCHANGE)
        gcode.register_command(
            "QUADRO_PARALLEL_MOVE",
            self.cmd_QUADRO_PARALLEL_MOVE,
            desc=self.cmd_QUADRO_PARALLEL_MOVE_help,
        )

    def cmd_QUADRO_RUN_TOOLCHANGE(self, gcmd):
        # Scope the acceleration to the ENTIRE macro, including its final
        # short park moves. Do not rely on a trailing G-code after an error.
        body = gcmd.get('BODY').upper()
        allowed = {'%s_T%d' % (source, dest)
                   for i, source in enumerate(('ZERO', 'ONE', 'TWO', 'THREE'))
                   for dest in range(4) if i != dest}
        if body not in allowed:
            raise gcmd.error('Invalid toolchange BODY')
        try:
            accel = finite(gcmd.get_float('ACCEL', self.toolchange_accel,
                                          above=0.), 'ACCEL', True)
        except PlanError as e:
            raise gcmd.error(str(e))
        params = gcmd.get_command_parameters()
        forwarded = []
        # These are the only movement parameters used by the supplied macros.
        for axis in ('X', 'Y'):
            if axis in params:
                try:
                    value = finite(params[axis], axis)
                except PlanError as e:
                    raise gcmd.error(str(e))
                forwarded.append('%s=%.12g' % (axis, value))
        toolhead = self.printer.lookup_object('toolhead')
        toolhead.flush_step_generation()
        previous_accel = toolhead.get_max_velocity()[1]
        toolhead.set_max_velocities(None, accel, None, None)
        try:
            self.printer.lookup_object('gcode').run_script_from_command(
                '_QUADRO_BODY_%s %s' % (body, ' '.join(forwarded)))
        finally:
            # Make the final G1 moves retain their toolchange acceleration
            # even if they are still in lookahead when this macro returns.
            try:
                toolhead.flush_step_generation()
            finally:
                toolhead.set_max_velocities(None, previous_accel, None, None)

    def _delayed_stepper_groups(self, dc, wrappers, kin, toolhead):
        # Only support the independent-axis topology inspected for Quadro.
        # Refuse coupled steppers before altering any queue or transform.
        if len(dc.dc_rails) != 4 or any(w.axis != 0 for w in wrappers.values()):
            raise self.printer.command_error('Delayed move requires four X carriages')
        if (sum(w.mode == 'PRIMARY' for w in wrappers.values()) != 1
                or any(w.mode not in ('PRIMARY', 'INACTIVE')
                       for w in wrappers.values())):
            raise self.printer.command_error(
                'Delayed move requires one PRIMARY and three INACTIVE carriages')
        groups = {t: list(wrappers[n].rail.get_steppers())
                  for t, n in self.TOOL_NAMES.items()}
        groups.update(Y=[], Z=[])
        owner = {}
        for t in TOOLS:
            for s in groups[t]:
                if s in owner:
                    raise self.printer.command_error('Shared X stepper is unsupported')
                owner[s] = t
        checked = set()
        for ks in kin.kin_steppers:
            s = ks.get_stepper()
            coeffs = ks.get_kin_coeffs()
            if s in owner:
                axis = 0
                if len(ks.get_carriages()) != 1:
                    raise self.printer.command_error('Coupled X stepper is unsupported')
            else:
                active = [i for i, v in enumerate(coeffs) if v]
                if active not in ([1], [2]):
                    raise self.printer.command_error('Unsupported shared-axis stepper')
                axis = active[0]
                groups['XYZ'[axis]].append(s)
            if coeffs != tuple(1. if j == axis else 0. for j in range(3)):
                raise self.printer.command_error('Delayed move requires unit axis coefficients')
            if s.get_trapq() != toolhead.get_trapq():
                raise self.printer.command_error('Stepper is already on a separate queue')
            checked.add(s)
        if checked != set(kin.get_steppers()) or any(not g for g in groups.values()):
            raise self.printer.command_error('Incomplete Quadro stepper mapping')
        return groups

    def _execute_delayed_move(self, gcmd, dc, wrappers, state, move_state,
                              current, targets, requested, speed,
                              min_clearance, arriving):
        import chelper
        toolhead = self.printer.lookup_object('toolhead')
        kin = toolhead.get_kinematics()
        groups = self._delayed_stepper_groups(dc, wrappers, kin, toolhead)
        start_pos = list(toolhead.get_position())
        end_pos = list(move_state['toolhead_position'])
        max_velocity, accel = toolhead.get_max_velocity()
        speed = min(finite(speed, 'SPEED', True), max_velocity)
        ranges = {t: wrappers[n].rail.get_range()
                  for t, n in self.TOOL_NAMES.items()}
        shared = {}
        for axis, label in ((1, 'Y'), (2, 'Z')):
            if start_pos[axis] != end_pos[axis]:
                axis_speed, axis_accel = speed, accel
                if axis == 2:
                    axis_speed = min(axis_speed, kin.max_z_velocity)
                    axis_accel = min(axis_accel, kin.max_z_accel)
                shared[label] = (start_pos[axis], end_pos[axis],
                                 axis_speed, axis_accel)
                ranges[label] = kin.limits[axis]
        try:
            plan = make_plan(
                {t: current[n] for t, n in self.TOOL_NAMES.items()},
                {t: targets[self.TOOL_NAMES[t]] for t in requested},
                arriving, speed, accel, min_clearance, ranges, shared)
        except PlanError as e:
            raise gcmd.error(str(e))
        gcmd.respond_info('QUADRO delayed plan: ARRIVING=%s delay=%.6fs '
                          'finish=%.6fs speed=%.3f accel=%.3f' % (
                              arriving, plan.profiles[arriving].delay,
                              plan.finish_time, speed, accel))
        if gcmd.get_int('PLAN_ONLY', 0, minval=0, maxval=1):
            for name, p in plan.profiles.items():
                gcmd.respond_info('%s: start=%.6f target=%.6f delay=%.6f '
                                  'duration=%.6f peak_speed=%.3f' % (
                                      name, p.start, p.target, p.delay,
                                      p.duration, p.peak_speed))
            return False
        if not plan.finish_time:
            return True
        mq = self.printer.lookup_object('motion_queuing')
        ffi_main, ffi_lib = chelper.get_ffi()
        toolhead.flush_step_generation()
        if self._delayed_queues is None:
            self._delayed_queues = {name: mq.allocate_trapq() for name in groups}
        queues = self._delayed_queues
        original_trapqs = {s: s.get_trapq() for g in groups.values() for s in g}
        modes = {n: w.mode for n, w in wrappers.items()}
        scales = {n: w.scale for n, w in wrappers.items()}
        # Scan-window support is retained; it is not used to optimize arrival
        # delays. The input-shaper kinematics objects are never replaced.
        try:
            for w in wrappers.values():
                w.scale, w.offset = 1., 0.
                w.apply_transform()
            for name, steppers in groups.items():
                for s in steppers:
                    s.set_trapq(queues[name])
            mq.check_step_generation_scan_windows()
            start_time = toolhead.get_last_move_time()
            append = mq.lookup_trapq_append()
            with self.printer.get_reactor().assert_no_pause():
                for name, queue in queues.items():
                    axis = 0 if name in TOOLS else 'XYZ'.index(name)
                    p = plan.profiles.get(name)
                    coord = list(start_pos[:3])
                    if name in TOOLS:
                        coord[0] = current[self.TOOL_NAMES[name]]
                    ffi_lib.trapq_set_position(queue, start_time, *coord)
                    # A stationary prefix supplies the correct position to
                    # input-shaper scans before the scheduled first movement.
                    guard = mq.get_kin_flush_delay() + .001
                    append(queue, start_time - guard, 0., guard, 0.,
                           *coord, 0., 0., 0., 0., 0., 0.)
                    if p is not None and p.distance:
                        direction = [0., 0., 0.]
                        direction[axis] = 1. if p.target > p.start else -1.
                        append(queue, start_time + p.delay,
                               p.accel_time, p.cruise_time, p.accel_time,
                               *coord, *direction, 0., p.peak_speed, p.accel)
                        coord[axis] = p.target
                        completed = p.end_time
                    else:
                        completed = 0.
                    # Hold early arrivals, stationary heads and shared axes
                    # through the common end. The tail sentinel holds after it.
                    hold = plan.finish_time - completed
                    if hold > 0.:
                        append(queue, start_time + completed, 0., hold, 0.,
                               *coord, 0., 0., 0., 0., 0., 0.)
                end_time = start_time + plan.finish_time
                toolhead._advance_move_time(end_time)
                mq.note_mcu_movequeue_activity(end_time)
            toolhead.flush_step_generation()
            # All shaped steps must have been generated before restoring the
            # main queues. Keep their time window outside the next movement.
            toolhead._advance_move_time(max(end_time, mq.last_step_gen_time))
            toolhead.set_position(end_pos, preserve_stepper_position=True)
            for name, w in wrappers.items():
                w.scale = scales[name]
                w.offset = targets[name] - w.scale * end_pos[0]
                w.mode = modes[name]
                w.apply_transform()
            for s, queue in original_trapqs.items():
                s.set_trapq(queue)
            mq.check_step_generation_scan_windows()
            kin.update_limits(0, dc.get_kin_range(toolhead, 0))
            self.printer.send_event('toolhead:manual_move')
        except Exception:
            # Once private queues/transforms are installed, do not pretend
            # a partial motion reached its endpoint or continue printing.
            self.printer.invoke_shutdown('Quadro delayed motion execution failed')
            raise
        return True

    def _get_dc(self):
        return self.printer.lookup_object("dual_carriage")

    def _get_wrappers(self, dc):
        wrappers = {}

        for short_name in self.PHYSICAL_ORDER:
            wrapper = dc.dc_rails.get(short_name)

            if wrapper is None:
                raise self.printer.command_error(
                    "Quadro carriage '%s' not found" % short_name
                )

            wrappers[short_name] = wrapper

        return wrappers

    def _state_name(self, wrappers, short_name):
        return wrappers[short_name].get_name()

    def _get_positions(self, state, wrappers):
        result = {}

        for short_name in self.PHYSICAL_ORDER:
            full_name = self._state_name(wrappers, short_name)
            result[short_name] = state["carriage_positions"][full_name]

        return result

    def _check_limits(self, positions, wrappers):
        eps = 0.000001

        for short_name in self.PHYSICAL_ORDER:
            target = positions[short_name]
            rail = wrappers[short_name].rail

            if target < rail.position_min - eps:
                raise self.printer.command_error(
                    "%s target %.3f is below minimum %.3f"
                    % (short_name, target, rail.position_min)
                )

            if target > rail.position_max + eps:
                raise self.printer.command_error(
                    "%s target %.3f is above maximum %.3f"
                    % (short_name, target, rail.position_max)
                )

    def _check_clearance(self, positions, label, min_clearance):
        eps = 0.000001

        for i in range(len(self.PHYSICAL_ORDER) - 1):
            left_name = self.PHYSICAL_ORDER[i]
            right_name = self.PHYSICAL_ORDER[i + 1]

            left_x = positions[left_name]
            right_x = positions[right_name]

            clearance = right_x - left_x

            if clearance < min_clearance - eps:
                raise self.printer.command_error(
                    "%s clearance violation: "
                    "%s=%.3f, %s=%.3f, "
                    "clearance=%.3f mm, required=%.3f mm"
                    % (
                        label,
                        left_name,
                        left_x,
                        right_name,
                        right_x,
                        clearance,
                        min_clearance,
                    )
                )

    def _execute_parallel_move(
        self,
        dc,
        move_state,
        move_speed,
        y_target=None,
        z_target=None,
    ):
        toolhead = self.printer.lookup_object("toolhead")

        # Finish all previously queued motion before changing
        # carriage transforms.
        toolhead.flush_step_generation()

        move_pos = list(toolhead.get_position())
        dcs = list(dc.dc_rails.values())

        # Determine the real current physical position
        # of every carriage.
        cur_pos = []

        for carriage in dcs:
            dc.toggle_active_dc_rail(carriage)
            cur_pos.append(list(toolhead.get_position()))

        carriage_positions = move_state["carriage_positions"]

        dl = [
            carriage_positions[carriage.get_name()]
            - cur_pos[i][carriage.axis]
            for i, carriage in enumerate(dcs)
        ]

        # Same algorithm Klipper uses in
        # restore_dual_carriage_state().
        for axis in dc.axes:
            dc_ind = [
                i for i, carriage in enumerate(dcs)
                if carriage.axis == axis
            ]

            abs_dl = [abs(dl[i]) for i in dc_ind]

            if not abs_dl:
                continue

            max_dl = max(abs_dl)

            # It is possible to request only a Z movement.
            if max_dl < 0.000000001:
                continue

            primary_ind = dc_ind[abs_dl.index(max_dl)]
            primary_dc = dcs[primary_ind]

            dc.toggle_active_dc_rail(primary_dc)

            move_pos[axis] = \
                carriage_positions[primary_dc.get_name()]

            for secondary_ind in dc_ind:
                if secondary_ind == primary_ind:
                    continue

                if min(
                    abs(dl[primary_ind]),
                    abs(dl[secondary_ind]),
                ) < 0.000000001:
                    continue

                # Same direction -> COPY
                # Opposite direction -> MIRROR
                if dl[primary_ind] * dl[secondary_ind] > 0:
                    dc_mode = "COPY"
                else:
                    dc_mode = "MIRROR"

                secondary_dc = dcs[secondary_ind]

                secondary_dc.activate(
                    dc_mode,
                    cur_pos[primary_ind],
                )

                secondary_dc.override_axis_scaling(
                    abs(
                        dl[secondary_ind]
                        / dl[primary_ind]
                    ),
                    cur_pos[primary_ind],
                )

        # Include shared Y and/or Z in the exact same manual_move trajectory.
        # Y is common to all four X carriages, so there is only one Y target.
        if y_target is not None:
            move_pos[1] = y_target

        if z_target is not None:
            move_pos[2] = z_target

        toolhead.manual_move(
            move_pos,
            move_speed,
        )

        toolhead.flush_step_generation()

        # Restore normal carriage transformations.
        for carriage in dcs:
            carriage.inactivate(move_pos)

        # Restore logical coordinates for dual-carriage axes.
        for axis in dc.axes:
            move_pos[axis] = \
                move_state["toolhead_position"][axis]

        # Y/Z remain at their new physical targets.
        # The move is complete and inactivate() retained each physical
        # endpoint. Only the logical coordinates change here; preserve the
        # fractional step remainder for the next movement.
        toolhead.set_position(move_pos, preserve_stepper_position=True)

        saved_modes = move_state["carriage_modes"]

        saved_primary_dcs = [
            carriage
            for carriage in dc.dc_rails.values()
            if saved_modes[carriage.get_name()] == "PRIMARY"
        ]

        # Primary carriage(s) first.
        for carriage in saved_primary_dcs:
            dc.activate_dc_mode(
                carriage,
                "PRIMARY",
            )

        # Then restore all remaining modes.
        for carriage in dc.dc_rails.values():
            if carriage not in saved_primary_dcs:
                dc.activate_dc_mode(
                    carriage,
                    saved_modes[carriage.get_name()],
                )

    def cmd_QUADRO_PARALLEL_MOVE(self, gcmd):
        dc = self._get_dc()
        wrappers = self._get_wrappers(dc)

        toolhead = self.printer.lookup_object("toolhead")
        kin = toolhead.get_kinematics()

        eventtime = self.printer.get_reactor().monotonic()
        kin_status = kin.get_status(eventtime)

        if "x" not in kin_status.get("homed_axes", ""):
            raise gcmd.error(
                "X axis must be homed before QUADRO_PARALLEL_MOVE"
            )

        speed = gcmd.get_float(
            "SPEED",
            self.default_speed,
            above=0.0,
        )

        min_clearance = gcmd.get_float(
            "MIN_CLEARANCE",
            self.min_clearance,
            minval=0.0,
        )

        # Optional coordinated Y target.
        y_value = gcmd.get("Y", None)

        if y_value is None:
            y_target = None
        else:
            try:
                y_target = float(y_value)
            except ValueError:
                raise gcmd.error(
                    "Invalid Y target '%s'" % y_value
                )

            if "y" not in kin_status.get("homed_axes", ""):
                raise gcmd.error(
                    "Y axis must be homed when Y is specified"
                )

        # Optional coordinated Z target.
        z_value = gcmd.get("Z", None)

        if z_value is None:
            z_target = None
        else:
            try:
                z_target = float(z_value)
            except ValueError:
                raise gcmd.error(
                    "Invalid Z target '%s'" % z_value
                )

            if "z" not in kin_status.get("homed_axes", ""):
                raise gcmd.error(
                    "Z axis must be homed when Z is specified"
                )

        state = dc.save_dual_carriage_state()

        current = self._get_positions(
            state,
            wrappers,
        )

        targets = dict(current)
        requested = []

        for tool, short_name in self.TOOL_NAMES.items():
            value = gcmd.get(tool, None)

            if value is None:
                continue

            try:
                target = float(value)
            except ValueError:
                raise gcmd.error(
                    "Invalid %s target '%s'"
                    % (tool, value)
                )

            targets[short_name] = target
            requested.append(tool)

        if not requested and y_target is None and z_target is None:
            raise gcmd.error(
                "Specify T0/T1/T2/T3 and/or Y/Z target"
            )

        self._check_limits(
            targets,
            wrappers,
        )

        # Because every carriage displacement is an affine
        # function of the same master trajectory, adjacent
        # clearance changes linearly from start to finish.
        #
        # Therefore checking both endpoints is enough:
        # if start >= 56.25 and finish >= 56.25,
        # the middle cannot dip below both.
        self._check_clearance(
            current,
            "START",
            min_clearance,
        )

        self._check_clearance(
            targets,
            "TARGET",
            min_clearance,
        )

        move_state = copy.deepcopy(state)

        for short_name in self.PHYSICAL_ORDER:
            full_name = self._state_name(
                wrappers,
                short_name,
            )

            move_state["carriage_positions"][full_name] = \
                targets[short_name]

        # Keep the logical X coordinate associated with the
        # same carriage that was PRIMARY before this command.
        primary_short_name = None

        for short_name in self.PHYSICAL_ORDER:
            full_name = self._state_name(
                wrappers,
                short_name,
            )

            if state["carriage_modes"][full_name] == "PRIMARY":
                primary_short_name = short_name
                break

        if primary_short_name is None:
            raise gcmd.error(
                "No PRIMARY X carriage found"
            )

        new_toolhead_position = list(
            move_state["toolhead_position"]
        )

        new_toolhead_position[0] = \
            targets[primary_short_name]

        if y_target is not None:
            new_toolhead_position[1] = y_target

        if z_target is not None:
            new_toolhead_position[2] = z_target

        move_state["toolhead_position"] = tuple(
            new_toolhead_position
        )

        arriving = gcmd.get("ARRIVING", None)
        if arriving is None:
            if gcmd.get_int("PLAN_ONLY", 0):
                raise gcmd.error("PLAN_ONLY requires ARRIVING")
            self._execute_parallel_move(
                dc, move_state, speed, y_target=y_target, z_target=z_target)
        else:
            if not self._execute_delayed_move(
                    gcmd, dc, wrappers, state, move_state, current, targets,
                    requested, speed, min_clearance, arriving.upper()):
                return

        final_state = dc.save_dual_carriage_state()

        final_positions = self._get_positions(
            final_state,
            wrappers,
        )

        current_pos = toolhead.get_position()
        current_y = current_pos[1]
        current_z = current_pos[2]

        gcmd.respond_info(
            "QUADRO_PARALLEL_MOVE complete\n"
            "T0=%.3f T1=%.3f T2=%.3f T3=%.3f Y=%.3f Z=%.3f"
            % (
                final_positions["carriage_t0"],
                final_positions["carriage_t1"],
                final_positions["carriage_t2"],
                final_positions["carriage_t3"],
                current_y,
                current_z,
            )
        )

    cmd_QUADRO_PARALLEL_MOVE_help = (
        "Move multiple Quadro X carriages and optional shared Y/Z simultaneously"
    )


def load_config(config):
    return QuadroParallelCarriage(config)
```

## bed_pin_calibration.py
```python
# Drop-in for the printer (not imported by QuadroScreen).
# Copy to Klipper extras, e.g. /home/cp/klipper/klippy/extras/bed_pin_calibration.py
import json
import os

CONSISTENCY_TOL = 0.08 + 1e-9


class BedPinCalibration:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.reactor = self.printer.get_reactor()
        self.gcode = self.printer.lookup_object("gcode")

        self.last_result = None
        self.results = {}
        self.last_deltas = {"delta_x": 0.0, "delta_y": 0.0, "delta_z": 0.0}
        self.inconsistent_tool = ""
        self.last_consistent = True

        self.config_path = "/home/cp/printer_data/config/bed_pin_offsets.json"
        self.offsets = {}

        self.printer.register_event_handler("klippy:ready", self._load_offsets)

        self.positions_path = "/home/cp/printer_data/config/bed_pin_tool_positions.json"
        self.tool_positions = {}

        self.printer.register_event_handler("klippy:ready", self._load_tool_positions)

        self.gcode.register_command("BED_PIN_CALIBRATE_TOOL", self.cmd_BED_PIN_CALIBRATE_TOOL)
        self.gcode.register_command("BED_PIN_CALIBRATE_ALL", self.cmd_BED_PIN_CALIBRATE_ALL)
        self.gcode.register_command("BED_PIN_SAVE_OFFSETS", self.cmd_SAVE_OFFSETS)
        self.gcode.register_command("BED_PIN_LOAD_OFFSETS", self.cmd_LOAD_OFFSETS)
        self.gcode.register_command("BED_PIN_APPLY_OFFSET", self.cmd_APPLY_OFFSET)
        self.gcode.register_command("BED_PIN_PARK_FOR_CLEAN", self.cmd_BED_PIN_PARK_FOR_CLEAN)

    def _get_force(self):
        lc = self.printer.lookup_object("load_cell bed_pin")
        status = lc.get_status(self.reactor.monotonic())
        return float(status.get("force_g", 0.0))

    def get_status(self, eventtime):
        return {
            "last_result": self.last_result,
            "results": self.results,
            "offsets": self.offsets,
            "last_deltas": self.last_deltas,
            "inconsistent_tool": self.inconsistent_tool,
            "consistent": self.last_consistent,
        }

    def _clear_gcode_offsets(self):
        self.gcode.run_script_from_command(
            "SET_GCODE_OFFSET X=0.00000 Y=0.00000 Z=0.00000 MOVE=0"
        )

    def _home_and_reset_calibration_state(self):
        toolhead = self.printer.lookup_object("toolhead")
        self._clear_gcode_offsets()
        self.gcode.run_script_from_command("G28")
        self.gcode.run_script_from_command("G90")
        toolhead.wait_moves()
        self.gcode.run_script_from_command(
            "SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY"
        )
        self.gcode.run_script_from_command("ACTIVATE_EXTRUDER EXTRUDER=extruder")
        self._clear_gcode_offsets()
        toolhead.wait_moves()

    def _ensure_homed(self):
        toolhead = self.printer.lookup_object("toolhead")
        homed = toolhead.get_status(self.reactor.monotonic()).get("homed_axes", "")
        if "x" not in homed or "y" not in homed or "z" not in homed:
            self._home_and_reset_calibration_state()

    def _move_xy(self, x=None, y=None, speed=50.0):
        toolhead = self.printer.lookup_object("toolhead")
        pos = list(toolhead.get_position())
        if x is not None:
            pos[0] = x
        if y is not None:
            pos[1] = y
        toolhead.manual_move(pos, speed)
        toolhead.wait_moves()

    def _move_z(self, z, speed=2.0):
        toolhead = self.printer.lookup_object("toolhead")
        pos = list(toolhead.get_position())
        pos[2] = z
        toolhead.manual_move(pos, speed)
        toolhead.wait_moves()

    def _move_xy_then_z(self, x, y, z, xy_speed=50.0, z_speed=2.0):
        self._move_xy(x=x, y=y, speed=xy_speed)
        self._move_z(z=z, speed=z_speed)

    def _select_and_move_carriage(self, carriage, x, speed=50.0):
        self.gcode.run_script_from_command(
            "SET_DUAL_CARRIAGE CARRIAGE=%s" % carriage
        )
        self._move_xy(x=x, speed=speed)

    def _layout_for_tool(self, tool, active_x):
        layouts = {
            "T0": {
                "moves": [
                    ("carriage_t3", 469.00),
                    ("carriage_t2", 412.75),
                    ("carriage_t1", 356.50),
                    ("carriage_t0", active_x),
                ],
                "active": "carriage_t0",
            },
            "T1": {
                "moves": [
                    ("carriage_t0", -169.00),
                    ("carriage_t3", 469.00),
                    ("carriage_t2", 412.75),
                    ("carriage_t1", active_x),
                ],
                "active": "carriage_t1",
            },
            "T2": {
                "moves": [
                    ("carriage_t0", -169.00),
                    ("carriage_t1", -112.75),
                    ("carriage_t3", 469.00),
                    ("carriage_t2", active_x),
                ],
                "active": "carriage_t2",
            },
            "T3": {
                "moves": [
                    ("carriage_t0", -169.00),
                    ("carriage_t1", -112.75),
                    ("carriage_t2", -56.50),
                    ("carriage_t3", active_x),
                ],
                "active": "carriage_t3",
            },
        }
        return layouts[tool]

    def _validate_layout(self, tool, layout, min_clearance=56.25):
        positions = {carriage: float(x_pos) for carriage, x_pos in layout["moves"]}
        required = ["carriage_t0", "carriage_t1", "carriage_t2", "carriage_t3"]
        missing = [name for name in required if name not in positions]
        if missing:
            raise self.printer.command_error(
                "Unsafe calibration layout for %s: missing %s"
                % (tool, ", ".join(missing))
            )
        ordered = [positions[name] for name in required]
        for i in range(3):
            clearance = ordered[i + 1] - ordered[i]
            if clearance < min_clearance - 1e-6:
                raise self.printer.command_error(
                    "Unsafe calibration layout for %s: %s=%.3f %s=%.3f "
                    "clearance=%.3f < %.3f"
                    % (
                        tool,
                        required[i], ordered[i],
                        required[i + 1], ordered[i + 1],
                        clearance, min_clearance,
                    )
                )

    def _prepare_tool_at(self, tool, x, y, z, full_layout=True):
        self._ensure_homed()
        self._clear_gcode_offsets()
        self._move_z(z=5.0, speed=5.0)
        if full_layout:
            layout = self._layout_for_tool(tool, x)
            self._validate_layout(tool, layout)
            for carriage, x_pos in layout["moves"]:
                self._select_and_move_carriage(
                    carriage=carriage,
                    x=x_pos,
                    speed=50.0,
                )
            self.gcode.run_script_from_command(
                "SET_DUAL_CARRIAGE CARRIAGE=%s" % layout["active"]
            )
        self._move_xy_then_z(
            x=x,
            y=y,
            z=z,
            xy_speed=50.0,
            z_speed=2.0,
        )
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.2)

    def _park_active_for_clean(self):
        self._clear_gcode_offsets()
        self._move_z(z=20.0, speed=5.0)
        self._move_xy(x=150.0, y=0.0, speed=50.0)

    def cmd_BED_PIN_PARK_FOR_CLEAN(self, gcmd):
        self._park_active_for_clean()
        gcmd.respond_info("BED_PIN_PARK_FOR_CLEAN X=150 Y=0 Z=20")

    def _probe_axis_once(self, axis_index, direction, threshold, step, speed, max_distance):
        toolhead = self.printer.lookup_object("toolhead")
        moved = 0.0
        while True:
            force = self._get_force()
            if force >= threshold:
                pos = toolhead.get_position()
                self.last_result = {
                    "force": force,
                    "x": pos[0],
                    "y": pos[1],
                    "z": pos[2],
                    "moved": moved,
                }
                return True
            if moved >= max_distance:
                break
            pos = list(toolhead.get_position())
            pos[axis_index] += direction * step
            moved += step
            toolhead.manual_move(pos, speed)
            toolhead.wait_moves()
        pos = toolhead.get_position()
        self.last_result = {
            "force": self._get_force(),
            "x": pos[0],
            "y": pos[1],
            "z": pos[2],
            "moved": moved,
            "error": "no_contact",
        }
        return False

    def _probe_axis_coarse_fine(
        self,
        gcmd,
        axis_name,
        axis_index,
        direction,
        threshold,
        fine_step,
        fine_speed,
        max_distance,
        coarse_step,
        coarse_speed,
        retract,
    ):
        coarse_hit = self._probe_axis_once(
            axis_index=axis_index,
            direction=direction,
            threshold=threshold,
            step=coarse_step,
            speed=coarse_speed,
            max_distance=max_distance,
        )
        if not coarse_hit:
            r = self.last_result
            raise gcmd.error(
                "No coarse %s contact: force=%.2fg X=%.5f Y=%.5f Z=%.5f moved=%.3f"
                % (axis_name, r["force"], r["x"], r["y"], r["z"], r["moved"])
            )
        toolhead = self.printer.lookup_object("toolhead")
        pos = list(toolhead.get_position())
        pos[axis_index] -= direction * retract
        toolhead.manual_move(pos, coarse_speed)
        toolhead.wait_moves()
        self.reactor.pause(self.reactor.monotonic() + 0.2)
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.05)
        fine_hit = self._probe_axis_once(
            axis_index=axis_index,
            direction=direction,
            threshold=threshold,
            step=fine_step,
            speed=fine_speed,
            max_distance=retract + coarse_step + 1.0,
        )
        if not fine_hit:
            r = self.last_result
            raise gcmd.error(
                "No fine %s contact: force=%.2fg X=%.5f Y=%.5f Z=%.5f moved=%.3f"
                % (axis_name, r["force"], r["x"], r["y"], r["z"], r["moved"])
            )
        return dict(self.last_result)

    def _probe_z_from_current(self, gcmd, threshold, fine_step, fine_speed, max_distance,
                              coarse_step, coarse_speed, retract):
        return self._probe_axis_coarse_fine(
            gcmd=gcmd,
            axis_name="Z",
            axis_index=2,
            direction=-1.0,
            threshold=threshold,
            fine_step=fine_step,
            fine_speed=fine_speed,
            max_distance=max_distance,
            coarse_step=coarse_step,
            coarse_speed=coarse_speed,
            retract=retract,
        )

    def _probe_x_side_from_current(self, gcmd, side, threshold, fine_step, fine_speed,
                                   max_distance, coarse_step, coarse_speed, retract):
        if side == "LEFT":
            direction = 1.0
        elif side == "RIGHT":
            direction = -1.0
        else:
            raise gcmd.error("Unknown X side=%s" % side)
        return self._probe_axis_coarse_fine(
            gcmd=gcmd,
            axis_name="X",
            axis_index=0,
            direction=direction,
            threshold=threshold,
            fine_step=fine_step,
            fine_speed=fine_speed,
            max_distance=max_distance,
            coarse_step=coarse_step,
            coarse_speed=coarse_speed,
            retract=retract,
        )

    def _probe_y_side_from_current(self, gcmd, side, threshold, fine_step, fine_speed,
                                   max_distance, coarse_step, coarse_speed, retract):
        if side == "FRONT":
            direction = 1.0
        elif side == "BACK":
            direction = -1.0
        else:
            raise gcmd.error("Unknown Y side=%s" % side)
        return self._probe_axis_coarse_fine(
            gcmd=gcmd,
            axis_name="Y",
            axis_index=1,
            direction=direction,
            threshold=threshold,
            fine_step=fine_step,
            fine_speed=fine_speed,
            max_distance=max_distance,
            coarse_step=coarse_step,
            coarse_speed=coarse_speed,
            retract=retract,
        )

    def _parse_probe_params(self, gcmd):
        return {
            "threshold": gcmd.get_float("THRESHOLD", 25.0),
            "xy_fine_step": gcmd.get_float("XY_STEP", 0.01),
            "z_fine_step": gcmd.get_float("Z_STEP", 0.01),
            "xy_fine_speed": gcmd.get_float("SPEED", 20.0),
            "z_fine_speed": gcmd.get_float("Z_SPEED", 2.0),
            "coarse_step": gcmd.get_float("COARSE_STEP", 0.20),
            "xy_coarse_speed": gcmd.get_float("COARSE_SPEED", 20.0),
            "z_coarse_speed": gcmd.get_float("Z_COARSE_SPEED", 5.0),
            "retract": gcmd.get_float("RETRACT", 1.0),
            "xy_max_distance": gcmd.get_float("MAX_DISTANCE", 12.0),
            "z_max_distance": gcmd.get_float("Z_MAX_DISTANCE", 5.0),
            "side_z_override": gcmd.get_float("SIDE_Z", -1.0),
        }

    def _approach_for_cycle(self, tool, gcmd, cycle_index):
        pos = self.tool_positions[tool]
        if cycle_index == 0:
            top_x = gcmd.get_float("TOP_X", pos["top_x"])
            top_y = gcmd.get_float("TOP_Y", pos["top_y"])
            side_z_margin = gcmd.get_float("SIDE_Z_MARGIN", pos["side_z_margin"])
            left_x = gcmd.get_float("LEFT_X", pos["left_x"])
            right_x = gcmd.get_float("RIGHT_X", pos["right_x"])
            front_y = gcmd.get_float("FRONT_Y", pos["front_y"])
            back_y = gcmd.get_float("BACK_Y", pos["back_y"])
        else:
            top_x = pos["top_x"]
            top_y = pos["top_y"]
            side_z_margin = pos["side_z_margin"]
            left_x = pos["left_x"]
            right_x = pos["right_x"]
            front_y = pos["front_y"]
            back_y = pos["back_y"]
        return {
            "top_x": top_x,
            "top_y": top_y,
            "side_z_margin": side_z_margin,
            "left_x": left_x,
            "right_x": right_x,
            "front_y": front_y,
            "back_y": back_y,
        }

    def _run_one_cycle(self, gcmd, tool, probe, approach, full_layout):
        self._prepare_tool_at(
            tool, approach["top_x"], approach["top_y"], 5.0, full_layout=full_layout
        )
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.2)
        z_result = self._probe_z_from_current(
            gcmd=gcmd,
            threshold=probe["threshold"],
            fine_step=probe["z_fine_step"],
            fine_speed=probe["z_fine_speed"],
            max_distance=probe["z_max_distance"],
            coarse_step=probe["coarse_step"],
            coarse_speed=probe["z_coarse_speed"],
            retract=probe["retract"],
        )
        self._move_z(z=5.0, speed=5.0)
        if probe["side_z_override"] >= 0.0:
            side_z = probe["side_z_override"]
        else:
            side_z = z_result["z"] - approach["side_z_margin"]
        self._move_xy_then_z(
            x=approach["left_x"], y=approach["top_y"], z=side_z, xy_speed=50.0, z_speed=2.0
        )
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.2)
        x_left = self._probe_x_side_from_current(
            gcmd=gcmd,
            side="LEFT",
            threshold=probe["threshold"],
            fine_step=probe["xy_fine_step"],
            fine_speed=probe["xy_fine_speed"],
            max_distance=probe["xy_max_distance"],
            coarse_step=probe["coarse_step"],
            coarse_speed=probe["xy_coarse_speed"],
            retract=probe["retract"],
        )
        self._move_z(z=5.0, speed=5.0)
        self._move_xy_then_z(
            x=approach["right_x"], y=approach["top_y"], z=side_z, xy_speed=50.0, z_speed=2.0
        )
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.2)
        x_right = self._probe_x_side_from_current(
            gcmd=gcmd,
            side="RIGHT",
            threshold=probe["threshold"],
            fine_step=probe["xy_fine_step"],
            fine_speed=probe["xy_fine_speed"],
            max_distance=probe["xy_max_distance"],
            coarse_step=probe["coarse_step"],
            coarse_speed=probe["xy_coarse_speed"],
            retract=probe["retract"],
        )
        center_x = (x_left["x"] + x_right["x"]) / 2.0
        self._move_z(z=5.0, speed=5.0)
        self._move_xy_then_z(
            x=approach["top_x"], y=approach["front_y"], z=side_z, xy_speed=50.0, z_speed=2.0
        )
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.2)
        y_front = self._probe_y_side_from_current(
            gcmd=gcmd,
            side="FRONT",
            threshold=probe["threshold"],
            fine_step=probe["xy_fine_step"],
            fine_speed=probe["xy_fine_speed"],
            max_distance=probe["xy_max_distance"],
            coarse_step=probe["coarse_step"],
            coarse_speed=probe["xy_coarse_speed"],
            retract=probe["retract"],
        )
        self._move_z(z=5.0, speed=5.0)
        self._move_xy_then_z(
            x=approach["top_x"], y=approach["back_y"], z=side_z, xy_speed=50.0, z_speed=2.0
        )
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.2)
        y_back = self._probe_y_side_from_current(
            gcmd=gcmd,
            side="BACK",
            threshold=probe["threshold"],
            fine_step=probe["xy_fine_step"],
            fine_speed=probe["xy_fine_speed"],
            max_distance=probe["xy_max_distance"],
            coarse_step=probe["coarse_step"],
            coarse_speed=probe["xy_coarse_speed"],
            retract=probe["retract"],
        )
        center_y = (y_front["y"] + y_back["y"]) / 2.0
        self._move_z(z=5.0, speed=5.0)
        return {
            "tool": tool,
            "z": z_result,
            "x_left": x_left,
            "x_right": x_right,
            "center_x": center_x,
            "y_front": y_front,
            "y_back": y_back,
            "center_y": center_y,
            "side_z_margin": approach["side_z_margin"],
        }

    def _apply_working_center(self, tool, result):
        self.tool_positions[tool]["top_x"] = result["center_x"]
        self.tool_positions[tool]["top_y"] = result["center_y"]
        self.tool_positions[tool]["side_z_margin"] = result["side_z_margin"]
        self.tool_positions[tool]["last_measured_top_z"] = result["z"]["z"]

    def _commit_tool_result(self, tool, result):
        self.results[tool] = result
        self.last_result = result
        self._apply_working_center(tool, result)
        self._save_tool_positions()

    def _measure_deltas(self, first, second):
        return {
            "delta_x": abs(first["center_x"] - second["center_x"]),
            "delta_y": abs(first["center_y"] - second["center_y"]),
            "delta_z": abs(first["z"]["z"] - second["z"]["z"]),
        }

    def _deltas_ok(self, deltas):
        return (
            deltas["delta_x"] <= CONSISTENCY_TOL
            and deltas["delta_y"] <= CONSISTENCY_TOL
            and deltas["delta_z"] <= CONSISTENCY_TOL
        )

    def _respond_cycle(self, gcmd, tool, cycle_index, total, result):
        gcmd.respond_info(
            "BED_PIN_CALIBRATE_TOOL %s cycle %d/%d: Z=%.5f "
            "X_LEFT=%.5f X_RIGHT=%.5f Y_BACK=%.5f Y_FRONT=%.5f "
            "CENTER_X=%.5f CENTER_Y=%.5f"
            % (
                tool,
                cycle_index + 1,
                total,
                result["z"]["z"],
                result["x_left"]["x"],
                result["x_right"]["x"],
                result["y_back"]["y"],
                result["y_front"]["y"],
                result["center_x"],
                result["center_y"],
            )
        )

    def _set_calibration_status(self, stage, deltas=None, inconsistent_tool=""):
        if deltas is None:
            deltas = {"delta_x": 0.0, "delta_y": 0.0, "delta_z": 0.0}
        try:
            self.gcode.run_script_from_command(
                "SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='\"%s\"'"
                % stage
            )
            self.gcode.run_script_from_command(
                "SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=delta_x VALUE=%.5f"
                % deltas["delta_x"]
            )
            self.gcode.run_script_from_command(
                "SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=delta_y VALUE=%.5f"
                % deltas["delta_y"]
            )
            self.gcode.run_script_from_command(
                "SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=delta_z VALUE=%.5f"
                % deltas["delta_z"]
            )
            self.gcode.run_script_from_command(
                "SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=inconsistent_tool VALUE='\"%s\"'"
                % inconsistent_tool
            )
        except Exception:
            pass

    def _fail_tool(self, gcmd, tool, message):
        self.inconsistent_tool = tool
        self.last_consistent = False
        self._park_active_for_clean()
        self._set_calibration_status(
            "CALIBRATION_LEVELING_%s_INCONSISTENT" % tool,
            deltas=self.last_deltas,
            inconsistent_tool=tool,
        )
        gcmd.respond_info("BED_PIN_CALIBRATE_TOOL %s %s" % (tool, message))

    def cmd_BED_PIN_CALIBRATE_TOOL(self, gcmd):
        tool = gcmd.get("TOOL", "T0").upper()
        reset_state = gcmd.get_int("RESET", 1, minval=0, maxval=1)
        retry = gcmd.get_int("RETRY", 0, minval=0, maxval=1)
        first = gcmd.get_int("FIRST", 0, minval=0, maxval=1)
        cycles_override = gcmd.get_int("CYCLES", 0, minval=0, maxval=3)

        if tool not in self.tool_positions:
            raise gcmd.error("Unknown TOOL=%s" % tool)

        if reset_state:
            self._home_and_reset_calibration_state()

        probe = self._parse_probe_params(gcmd)

        if cycles_override == 1:
            approach = self._approach_for_cycle(tool, gcmd, 0)
            result = self._run_one_cycle(gcmd, tool, probe, approach, full_layout=True)
            self._commit_tool_result(tool, result)
            self._respond_cycle(gcmd, tool, 0, 1, result)
            return

        if retry:
            n_cycles = 2
            compare_from = 0
        elif first:
            n_cycles = 3
            compare_from = 1
        else:
            n_cycles = 2
            compare_from = 0

        measurements = []
        for i in range(n_cycles):
            approach = self._approach_for_cycle(tool, gcmd, i)
            try:
                result = self._run_one_cycle(
                    gcmd, tool, probe, approach, full_layout=(i == 0)
                )
            except self.printer.command_error as exc:
                self._fail_tool(
                    gcmd, tool, "CONTACT_FAIL cycle %d/%d: %s" % (i + 1, n_cycles, exc)
                )
                return
            self._apply_working_center(tool, result)
            self.last_result = result
            measurements.append(result)
            self._respond_cycle(gcmd, tool, i, n_cycles, result)

        first_m = measurements[compare_from]
        second_m = measurements[-1]
        deltas = self._measure_deltas(first_m, second_m)
        self.last_deltas = deltas
        ok = self._deltas_ok(deltas)
        self.last_consistent = ok

        gcmd.respond_info(
            "BED_PIN_CALIBRATE_TOOL %s COMPARE: "
            "A CENTER_X=%.5f CENTER_Y=%.5f Z=%.5f "
            "B CENTER_X=%.5f CENTER_Y=%.5f Z=%.5f "
            "DELTA_X=%.5f DELTA_Y=%.5f DELTA_Z=%.5f %s"
            % (
                tool,
                first_m["center_x"], first_m["center_y"], first_m["z"]["z"],
                second_m["center_x"], second_m["center_y"], second_m["z"]["z"],
                deltas["delta_x"], deltas["delta_y"], deltas["delta_z"],
                "PASS" if ok else "FAIL",
            )
        )

        if ok:
            self.inconsistent_tool = ""
            self._commit_tool_result(tool, second_m)
            self._set_calibration_status(
                "CALIBRATION_LEVELING_%s_DONE" % tool
            )
            return

        self._fail_tool(gcmd, tool, "INCONSISTENT (no raise, offsets not committed)")

    def cmd_BED_PIN_CALIBRATE_ALL(self, gcmd):
        self.results = {}
        self._home_and_reset_calibration_state()
        for tool in ["T0", "T1", "T2", "T3"]:
            cmd = self.gcode.create_gcode_command(
                "BED_PIN_CALIBRATE_TOOL",
                "BED_PIN_CALIBRATE_TOOL",
                {
                    "TOOL": tool,
                    "RESET": 0,
                    "CYCLES": 1,
                    "THRESHOLD": gcmd.get_float("THRESHOLD", 25.0),
                    "XY_STEP": gcmd.get_float("XY_STEP", 0.01),
                    "Z_STEP": gcmd.get_float("Z_STEP", 0.01),
                    "SPEED": gcmd.get_float("SPEED", 20.0),
                    "Z_SPEED": gcmd.get_float("Z_SPEED", 2.0),
                    "COARSE_STEP": gcmd.get_float("COARSE_STEP", 0.20),
                    "COARSE_SPEED": gcmd.get_float("COARSE_SPEED", 20.0),
                    "Z_COARSE_SPEED": gcmd.get_float("Z_COARSE_SPEED", 5.0),
                    "RETRACT": gcmd.get_float("RETRACT", 1.0),
                    "MAX_DISTANCE": gcmd.get_float("MAX_DISTANCE", 12.0),
                    "Z_MAX_DISTANCE": gcmd.get_float("Z_MAX_DISTANCE", 5.0),
                },
            )
            self.cmd_BED_PIN_CALIBRATE_TOOL(cmd)
        t0 = self.results["T0"]
        x0 = t0["center_x"]
        y0 = t0["center_y"]
        z0 = t0["z"]["z"]
        for tool in ["T0", "T1", "T2", "T3"]:
            r = self.results[tool]
            r["x_offset_vs_t0"] = r["center_x"] - x0
            r["y_offset_vs_t0"] = r["center_y"] - y0
            r["z_offset_vs_t0"] = r["z"]["z"] - z0
        gcmd.respond_info(
            "BED_PIN_CALIBRATE_ALL OFFSETS vs T0: "
            "T0 X=0.00000 Y=0.00000 Z=0.00000 "
            "T1 X=%.5f Y=%.5f Z=%.5f "
            "T2 X=%.5f Y=%.5f Z=%.5f "
            "T3 X=%.5f Y=%.5f Z=%.5f"
            % (
                self.results["T1"]["x_offset_vs_t0"],
                self.results["T1"]["y_offset_vs_t0"],
                self.results["T1"]["z_offset_vs_t0"],
                self.results["T2"]["x_offset_vs_t0"],
                self.results["T2"]["y_offset_vs_t0"],
                self.results["T2"]["z_offset_vs_t0"],
                self.results["T3"]["x_offset_vs_t0"],
                self.results["T3"]["y_offset_vs_t0"],
                self.results["T3"]["z_offset_vs_t0"],
            )
        )

    def _save_offsets_to_file(self):
        offsets = {}
        for tool in ["T0", "T1", "T2", "T3"]:
            if tool in self.results:
                offsets[tool] = {
                    "x": self.results[tool]["x_offset_vs_t0"],
                    "y": self.results[tool]["y_offset_vs_t0"],
                    "z": self.results[tool]["z_offset_vs_t0"],
                }
        tmp_path = self.config_path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(offsets, f, indent=4)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, self.config_path)
        self.offsets = offsets

    def _load_offsets(self):
        try:
            with open(self.config_path, 'r') as f:
                self.offsets = json.load(f)
        except FileNotFoundError:
            self.offsets = {}

    def cmd_SAVE_OFFSETS(self, gcmd):
        required = ["T0", "T1", "T2", "T3"]
        missing = [tool for tool in required if tool not in self.results]
        if missing:
            raise gcmd.error(
                "Refusing to overwrite offsets with incomplete calibration. "
                "Missing: %s. Run BED_PIN_CALIBRATE_ALL first."
                % ", ".join(missing)
            )
        if "x_offset_vs_t0" not in self.results.get("T0", {}):
            gcmd.respond_info("Calculating offsets vs T0...")
            self._calculate_offsets()
        self._save_offsets_to_file()
        lines = ["Offsets saved to %s:" % self.config_path]
        for tool in ["T0", "T1", "T2", "T3"]:
            if tool in self.results:
                r = self.results[tool]
                lines.append(
                    "%s: X=%.3f Y=%.3f Z=%.3f"
                    % (tool, r["x_offset_vs_t0"], r["y_offset_vs_t0"], r["z_offset_vs_t0"])
                )
        gcmd.respond_info("\n".join(lines))

    def _calculate_offsets(self):
        if "T0" not in self.results:
            raise Exception("T0 calibration is required as reference")
        t0 = self.results["T0"]
        x0 = t0["center_x"]
        y0 = t0["center_y"]
        z0 = t0["z"]["z"]
        for tool, r in self.results.items():
            r["x_offset_vs_t0"] = r["center_x"] - x0
            r["y_offset_vs_t0"] = r["center_y"] - y0
            r["z_offset_vs_t0"] = r["z"]["z"] - z0

    def cmd_LOAD_OFFSETS(self, gcmd):
        self._load_offsets()
        gcmd.respond_info("Bed pin offsets loaded from %s" % self.config_path)

    def cmd_APPLY_OFFSET(self, gcmd):
        tool = gcmd.get("TOOL", "T0").upper()
        offset = self.offsets.get(tool, {"x": 0.0, "y": 0.0, "z": 0.0})
        self.gcode.run_script_from_command(
            "SET_GCODE_OFFSET Z=%.5f MOVE=0" % offset["z"]
        )
        self.gcode.run_script_from_command(
            "SET_GCODE_OFFSET X=%.5f Y=%.5f MOVE=0"
            % (offset["x"], offset["y"])
        )
        gcmd.respond_info("Applied offset for %s: X=%.5f Y=%.5f Z=%.5f"
                        % (tool, offset["x"], offset["y"], offset["z"]))

    def _default_tool_positions(self):
        return {
            "T0": {"top_x": 252.300, "top_y": 306.000, "side_z_margin": 1.0,
                "left_x": 243.00, "right_x": 259.00, "front_y": 300.00, "back_y": 311.00},
            "T1": {"top_x": 252.300, "top_y": 306.000, "side_z_margin": 1.0,
                "left_x": 243.00, "right_x": 259.00, "front_y": 300.00, "back_y": 311.00},
            "T2": {"top_x": 252.300, "top_y": 306.000, "side_z_margin": 1.0,
                "left_x": 243.00, "right_x": 259.00, "front_y": 300.00, "back_y": 311.00},
            "T3": {"top_x": 252.300, "top_y": 306.000, "side_z_margin": 1.0,
                "left_x": 243.00, "right_x": 259.00, "front_y": 300.00, "back_y": 311.00},
        }

    def _load_tool_positions(self):
        try:
            with open(self.positions_path, 'r') as f:
                self.tool_positions = json.load(f)
        except FileNotFoundError:
            self.tool_positions = self._default_tool_positions()
            self._save_tool_positions()
        defaults = self._default_tool_positions()
        for tool, vals in defaults.items():
            self.tool_positions.setdefault(tool, {})
            for k, v in vals.items():
                self.tool_positions[tool].setdefault(k, v)

    def _save_tool_positions(self):
        tmp_path = self.positions_path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(self.tool_positions, f, indent=4)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, self.positions_path)


def load_config(config):
    return BedPinCalibration(config)
```

## axis_slip_test.py
```python
# Axis slip (lost step) test for the Quadro printer.
#
# Touches the bed pin, runs a burst motion pattern at the requested
# acceleration / velocity, touches the pin again and reports how far the
# contact position moved.  Touching is done by [bed_pin_calibration], so it
# behaves exactly like the tool offset calibration (same thresholds, same
# carriage layout, same per-tool approach positions).
#
# Install:
#   copy to /home/cp/klipper/klippy/extras/axis_slip_test.py
#   printer.cfg:
#       [axis_slip_test]
#       #tolerance: 0.15        # mm, differences below this are "no slip"
#       #cycle_distance: 0.8    # mm per 4 full steps (rotation_distance/200*4)
#       #x_min: 50              # burst stroke limits
#       #x_max: 250
#       #y_min: 50
#       #y_max: 250
#       #x_test_y: 150          # Y position while the X burst runs
#       #burst_z: 10            # Z height while the burst runs
#       #low_accel: 1000        # accel of the slow lead-in moves (section 3)
#       #unhome_on_slip: True   # mark the axis unhomed when a slip is found
#
# Commands:
#   AXIS_SLIP_TEST  AXIS=Y TOOL=T0 ACCEL=7000 VELOCITY=300
#   AXIS_SLIP_TEST  AXIS=X TOOL=T2 ACCEL=9000 VELOCITY=400 MIN=40 MAX=260
#   AXIS_SLIP_SWEEP AXIS=Y START=4000 END=12000 STEP=1000 VELOCITY=300
#
#   Optional: REPEAT=1 (burst repetitions), TOLERANCE=, MIN=, MAX=, and every
#   supported probing parameter of BED_PIN_CALIBRATE_TOOL (THRESHOLD, XY_STEP, SPEED,
#   COARSE_STEP, COARSE_SPEED, RETRACT, MAX_DISTANCE, SIDE_Z, ...).
#
# PROBE_ONLY=1 REPEAT=3 repeats contact measurements WITHOUT a motion burst.
# Requires an idle printer, G28 completed, clean nozzle and clear bed/path.
# Uses stored tool_positions (TOP_X/LEFT_X/etc overrides are not supported).
# Leaves the requested tool selected and applies its stored bed-pin offsets.
# Calibration JSON files are never written by this test.
# Y touches the pin from the FRONT (+Y), X touches it from the LEFT (+X).
# diff = position after - position before.  A positive diff means the axis
# physically ended up short in the + direction (it lags towards -).
import logging
import math

VERSION = "2026-10-09-compatible-1"

SAFE_Z = 5.0   # same travel height bed_pin_calibration uses around the pin


class SlipTooLarge(Exception):
    pass


class AxisSlipTest:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.reactor = self.printer.get_reactor()
        self.gcode = self.printer.lookup_object("gcode")

        self.tolerance = config.getfloat("tolerance", 0.15, above=0.)
        self.cycle_distance = config.getfloat("cycle_distance", 0.8, above=0.)
        self.limits = {
            "X": (config.getfloat("x_min", 50.), config.getfloat("x_max", 250.)),
            "Y": (config.getfloat("y_min", 50.), config.getfloat("y_max", 250.)),
        }
        self.x_test_y = config.getfloat("x_test_y", 150.)
        self.burst_z = config.getfloat("burst_z", 10., minval=SAFE_Z)
        self.low_accel = config.getfloat("low_accel", 1000., above=0.)
        self.travel_speed = config.getfloat("travel_speed", 100., above=0.)
        self.travel_accel = config.getfloat("travel_accel", 2000., above=0.)
        self.unhome_on_slip = config.getboolean("unhome_on_slip", True)

        self.bpc = None
        self.last_result = None
        self.results = []
        self.running = False

        self.printer.register_event_handler("klippy:connect", self._handle_connect)
        self.gcode.register_command(
            "AXIS_SLIP_TEST", self.cmd_AXIS_SLIP_TEST,
            desc="Touch bed pin, run burst at ACCEL/VELOCITY, touch again")
        self.gcode.register_command(
            "AXIS_SLIP_SWEEP", self.cmd_AXIS_SLIP_SWEEP,
            desc="Raise ACCEL from START to END by STEP until the axis slips")

    def _handle_connect(self):
        self.bpc = self.printer.lookup_object("bed_pin_calibration")

    def get_status(self, eventtime):
        return {
            "running": self.running,
            "last_result": self.last_result,
            "results": self.results,
        }

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _parse_probe_params(self, gcmd):
        # Defaults match the supplied bed_pin_calibration implementation.
        defaults = {
            "threshold": ("THRESHOLD", 40.0),
            "xy_fine_step": ("XY_STEP", 0.01),
            "z_fine_step": ("Z_STEP", 0.01),
            "xy_fine_speed": ("SPEED", 20.0),
            "z_fine_speed": ("Z_SPEED", 2.0),
            "coarse_step": ("COARSE_STEP", 0.20),
            "xy_coarse_speed": ("COARSE_SPEED", 20.0),
            "z_coarse_speed": ("Z_COARSE_SPEED", 5.0),
            "retract": ("RETRACT", 1.0),
            "xy_max_distance": ("MAX_DISTANCE", 8.0),
            "z_max_distance": ("Z_MAX_DISTANCE", 5.0),
        }
        probe = {key: gcmd.get_float(param, default, above=0.)
                 for key, (param, default) in defaults.items()}
        probe["side_z_override"] = gcmd.get_float("SIDE_Z", -1.0)
        if not all(math.isfinite(value) for value in probe.values()):
            raise gcmd.error("Probe parameters must be finite")
        return probe

    def _probe_axis_once(self, axis_index, direction, threshold, step,
                         speed, max_distance):
        # Check force after EVERY step, including the final distance boundary.
        # Never overshoot max_distance by rounding up to a complete step.
        toolhead = self.printer.lookup_object("toolhead")
        moved = 0.0
        while True:
            force = self.bpc._get_force()
            if not math.isfinite(force):
                raise self.printer.command_error("Invalid bed pin force reading")
            pos = toolhead.get_position()
            hit = force >= threshold
            self._probe_result = dict(force=force, x=pos[0], y=pos[1],
                                      z=pos[2], moved=moved)
            if hit:
                return True
            remaining = max_distance - moved
            if remaining <= 1.e-9:
                self._probe_result["error"] = "no_contact"
                return False
            delta = min(step, remaining)
            target = list(pos)
            target[axis_index] += direction * delta
            toolhead.manual_move(target, speed)
            toolhead.wait_moves()
            moved += delta

    def _probe_axis_coarse_fine(
        self,
        gcmd,
        axis_name,
        axis_index,
        direction,
        threshold,
        fine_step,
        fine_speed,
        max_distance,
        coarse_step,
        coarse_speed,
        retract,
    ):
        coarse_hit = self._probe_axis_once(
            axis_index=axis_index,
            direction=direction,
            threshold=threshold,
            step=coarse_step,
            speed=coarse_speed,
            max_distance=max_distance,
        )

        if not coarse_hit:
            r = self._probe_result
            raise gcmd.error(
                "No coarse %s contact: force=%.2fg X=%.5f Y=%.5f Z=%.5f moved=%.3f"
                % (axis_name, r["force"], r["x"], r["y"], r["z"], r["moved"])
            )

        toolhead = self.printer.lookup_object("toolhead")
        pos = list(toolhead.get_position())
        pos[axis_index] -= direction * retract
        toolhead.manual_move(pos, coarse_speed)
        toolhead.wait_moves()

        self.reactor.pause(self.reactor.monotonic() + 0.2)

        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.05)

        fine_hit = self._probe_axis_once(
            axis_index=axis_index,
            direction=direction,
            threshold=threshold,
            step=fine_step,
            speed=fine_speed,
            max_distance=retract + coarse_step + 1.0,
        )

        if not fine_hit:
            r = self._probe_result
            raise gcmd.error(
                "No fine %s contact: force=%.2fg X=%.5f Y=%.5f Z=%.5f moved=%.3f"
                % (axis_name, r["force"], r["x"], r["y"], r["z"], r["moved"])
            )

        return dict(self._probe_result)

    def _probe_z_from_current(self, gcmd, threshold, fine_step, fine_speed, max_distance,
                              coarse_step, coarse_speed, retract):
        return self._probe_axis_coarse_fine(
            gcmd=gcmd,
            axis_name="Z",
            axis_index=2,
            direction=-1.0,
            threshold=threshold,
            fine_step=fine_step,
            fine_speed=fine_speed,
            max_distance=max_distance,
            coarse_step=coarse_step,
            coarse_speed=coarse_speed,
            retract=retract,
        )

    def _tare(self):
        self.gcode.run_script_from_command("LOAD_CELL_TARE LOAD_CELL=bed_pin")
        self.reactor.pause(self.reactor.monotonic() + 0.2)

    def _find_side_z(self, gcmd, tool, probe):
        # Arrange the carriages, go above the pin and find the Z at which the
        # nozzle side touches the pin (same way BED_PIN_CALIBRATE_TOOL does).
        pos = self.bpc.tool_positions[tool]
        self.bpc._prepare_tool_at(
            tool, pos["top_x"], pos["top_y"], SAFE_Z)
        extruder = "extruder" if tool == "T0" else "extruder" + tool[1:]
        self.gcode.run_script_from_command("ACTIVATE_EXTRUDER EXTRUDER=" + extruder)
        self._prepared_tool = tool
        if probe["side_z_override"] >= 0.0:
            return probe["side_z_override"]
        self._tare()
        z_result = self._probe_z_from_current(
            gcmd=gcmd,
            threshold=probe["threshold"],
            fine_step=probe["z_fine_step"],
            fine_speed=probe["z_fine_speed"],
            max_distance=probe["z_max_distance"],
            coarse_step=probe["coarse_step"],
            coarse_speed=probe["z_coarse_speed"],
            retract=probe["retract"],
        )
        self.bpc._move_z(z=SAFE_Z, speed=5.0)
        return z_result["z"] - pos["side_z_margin"]

    def _touch(self, gcmd, axis, tool, side_z, probe):
        # Returns the contact position on `axis`.
        # Raises SlipTooLarge if the pin is not where it is expected at all.
        pos = self.bpc.tool_positions[tool]
        if axis == "X":
            x, y, axis_index = pos["left_x"], pos["top_y"], 0
        else:
            x, y, axis_index = pos["top_x"], pos["front_y"], 1
        self.bpc._move_z(z=SAFE_Z, speed=5.0)
        self.bpc._move_xy(x=x, y=y, speed=50.0)
        # Guarded descent: if the axis slipped far enough to put the nozzle
        # above the pin, stop on contact instead of pressing into it.
        self._tare()
        guard_distance = SAFE_Z - side_z
        if guard_distance > 0.0:
            on_pin = self._probe_axis_once(
                axis_index=2, direction=-1.0,
                threshold=probe["threshold"],
                step=probe["coarse_step"],
                speed=probe["z_coarse_speed"],
                max_distance=guard_distance,
            )
            if on_pin:
                self.bpc._move_z(z=SAFE_Z, speed=5.0)
                raise SlipTooLarge(
                    "nozzle landed on top of the pin at the %s approach point"
                    % axis)
        self.bpc._move_z(z=side_z, speed=2.0)
        self._tare()
        try:
            result = self._probe_axis_coarse_fine(
                gcmd=gcmd,
                axis_name=axis,
                axis_index=axis_index,
                direction=1.0,
                threshold=probe["threshold"],
                fine_step=probe["xy_fine_step"],
                fine_speed=probe["xy_fine_speed"],
                max_distance=probe["xy_max_distance"],
                coarse_step=probe["coarse_step"],
                coarse_speed=probe["xy_coarse_speed"],
                retract=probe["retract"],
            )
        except self.printer.command_error as exc:
            if not str(exc).startswith("No "):
                raise
            self.bpc._move_z(z=SAFE_Z, speed=5.0)
            raise SlipTooLarge(
                "no %s contact within %.1f mm" % (axis, probe["xy_max_distance"]))
        # Leave the pin before lifting
        toolhead = self.printer.lookup_object("toolhead")
        back = list(toolhead.get_position())
        back[axis_index] -= probe["retract"]
        toolhead.manual_move(back, probe["xy_coarse_speed"])
        toolhead.wait_moves()
        self.bpc._move_z(z=SAFE_Z, speed=5.0)
        return result["x"] if axis_index == 0 else result["y"]

    def _burst_script(self, axis, accel, velocity, lo, hi, repeat):
        mid = (lo + hi) / 2.0
        fast = int(velocity * 60.0)
        lead, short, hop = 20.0, 20.0, 40.0
        lines = []

        def g1(target, feed):
            lines.append("G1 %s%.3f F%d" % (axis, target, feed))

        def limit(accel=None, velocity=None):
            cmd = "SET_VELOCITY_LIMIT"
            if velocity is not None:
                cmd += " VELOCITY=%.3f" % velocity
            if accel is not None:
                cmd += " ACCEL=%.3f" % accel
            lines.append(cmd)

        lines += ["SAVE_GCODE_STATE NAME=_AXIS_SLIP_BURST", "G90", "M220 S100"]
        limit(self.travel_accel, self.travel_speed)
        lines.append("G1 Z%.3f F600" % self.burst_z)
        if axis == "X":
            lines.append("G1 Y%.3f F%d" % (self.x_test_y, self.travel_speed * 60))
        g1(mid, 3000)
        lines.append("M400")
        for _ in range(repeat):
            # 1: wait, then take off at high accel
            limit(accel, velocity)
            for target in (hi, lo, hi, lo, mid):
                lines.append("G4 P500")
                g1(target, fast)
                lines.append("M400")
            # 2: slow -> fast transition in the same direction
            g1(mid - lead, 1800)
            g1(lo, fast)
            for _ in range(2):
                g1(lo + lead, 1800)
                g1(hi, fast)
                g1(hi - lead, 1800)
                g1(lo, fast)
            g1(lo + lead, 1800)
            g1(hi, fast)
            lines.append("M400")
            # 3: low accel move -> high accel reversal
            for _ in range(2):
                limit(self.low_accel)
                g1(hi - lead, 3000)
                lines.append("M400")
                limit(accel)
                g1(lo, fast)
                lines.append("M400")
                limit(self.low_accel)
                g1(lo + lead, 3000)
                lines.append("M400")
                limit(accel)
                g1(hi, fast)
                lines.append("M400")
            # 4: short stroke, frequent reversals
            for _ in range(10):
                g1(mid - short, fast)
                g1(mid + short, fast)
            lines.append("M400")
            # 5: mixed short and long moves
            g1(mid, 1800)
            for target in (lo, lo + hop, lo, hi, hi - hop, hi, lo, lo + hop, lo, hi):
                g1(target, fast)
            g1(hi - lead, 1800)
            g1(lo, fast)
            lines.append("M400")
        limit(self.travel_accel, self.travel_speed)
        g1(mid, 3000)
        lines.append("M400")
        lines.append("RESTORE_GCODE_STATE NAME=_AXIS_SLIP_BURST MOVE=0")
        return "\n".join(lines)

    def _mark_unhomed(self, axis):
        if not self.unhome_on_slip:
            return False
        try:
            toolhead = self.printer.lookup_object("toolhead")
            toolhead.get_kinematics().clear_homing_state(axis.lower())
            return True
        except Exception:
            logging.exception("axis_slip_test: could not clear homing state")
            return False

    # ------------------------------------------------------------------
    # test
    # ------------------------------------------------------------------
    def _run(self, gcmd, name, accels):
        if self.running:
            raise gcmd.error("Axis slip test is already running")
        axis = gcmd.get("AXIS", "Y").upper()
        if axis not in ("X", "Y"):
            raise gcmd.error("AXIS must be X or Y")
        tool = gcmd.get("TOOL", "T0").upper()
        if tool.isdigit():
            tool = "T" + tool
        if tool not in ("T0", "T1", "T2", "T3") or tool not in self.bpc.tool_positions:
            raise gcmd.error("Unknown TOOL=" + tool)
        velocity = gcmd.get_float("VELOCITY", 300., above=0.)
        repeat = gcmd.get_int("REPEAT", 1, minval=1, maxval=100)
        tolerance = gcmd.get_float("TOLERANCE", self.tolerance, above=0.)
        probe_only = gcmd.get_int("PROBE_ONLY", 0, minval=0, maxval=1)
        lo = gcmd.get_float("MIN", self.limits[axis][0])
        hi = gcmd.get_float("MAX", self.limits[axis][1])
        if not all(math.isfinite(v) for v in [velocity, tolerance, lo, hi] + accels):
            raise gcmd.error("Motion parameters must be finite")
        if hi - lo < 100.:
            raise gcmd.error("MAX - MIN must be at least 100 mm")
        probe = self._parse_probe_params(gcmd)
        toolhead = self.printer.lookup_object("toolhead")
        status = toolhead.get_status(self.reactor.monotonic())
        if not all(a in status.get("homed_axes", "") for a in "xyz"):
            raise gcmd.error("Home all axes with G28 before this test")
        print_stats = self.printer.lookup_object("print_stats", None)
        if print_stats is not None and print_stats.get_status(
                self.reactor.monotonic()).get("state") in ("printing", "paused"):
            raise gcmd.error("Run this test only while the printer is idle")
        orig_velocity, orig_accel = status["max_velocity"], status["max_accel"]
        saved_bpc_result = self.bpc.last_result
        self.gcode.run_script_from_command("SAVE_GCODE_STATE NAME=_AXIS_SLIP_OUTER")
        self.results, self.last_result = [], None
        self.running, self._prepared_tool = True, None
        failed, slipped, measurement_failed = True, False, False
        tag = "%s %s %s" % (name, axis, tool)
        gcmd.respond_info("%s version=%s PROBE_ONLY=%d" % (tag, VERSION, probe_only))
        try:
            self.gcode.run_script_from_command(
                "SET_VELOCITY_LIMIT VELOCITY=%.3f ACCEL=%.3f"
                % (self.travel_speed, self.travel_accel))
            side_z = self._find_side_z(gcmd, tool, probe)
            status = toolhead.get_status(self.reactor.monotonic())
            bounds_lo, bounds_hi = status["axis_minimum"], status["axis_maximum"]
            if not bounds_lo[2] <= side_z < SAFE_Z:
                raise gcmd.error("Measured SIDE_Z is outside the safe probing range")
            if not probe_only:
                index = 0 if axis == "X" else 1
                if lo < bounds_lo[index] or hi > bounds_hi[index]:
                    raise gcmd.error("MIN/MAX exceed active axis travel limits")
                if not bounds_lo[2] <= self.burst_z <= bounds_hi[2]:
                    raise gcmd.error("burst_z exceeds Z travel limits")
                if axis == "X" and not bounds_lo[1] <= self.x_test_y <= bounds_hi[1]:
                    raise gcmd.error("x_test_y exceeds Y travel limits")
            try:
                reference = self._touch(gcmd, axis, tool, side_z, probe)
            except SlipTooLarge as exc:
                raise gcmd.error("Reference MEASUREMENT_FAILED: %s" % exc)
            previous = reference
            gcmd.respond_info("%s REFERENCE=%.5f SIDE_Z=%.5f" % (tag, reference, side_z))
            trials = [None] * repeat if probe_only else accels
            for accel in trials:
                if not probe_only:
                    self.gcode.run_script_from_command(
                        self._burst_script(axis, accel, velocity, lo, hi, repeat))
                result = dict(axis=axis, tool=tool, accel=accel,
                              velocity=None if probe_only else velocity,
                              before=reference, previous=previous, after=None,
                              diff=None, step_diff=None, slipped=False,
                              probe_only=bool(probe_only), status="MEASUREMENT_FAILED")
                try:
                    after = self._touch(gcmd, axis, tool, side_z, probe)
                except SlipTooLarge as exc:
                    measurement_failed = True
                    result["note"] = str(exc)
                    line = "%s MEASUREMENT_FAILED: %s (slip not quantified)" % (tag, exc)
                else:
                    diff, step_diff = after - reference, after - previous
                    exceeded = abs(diff) > tolerance
                    slipped = exceeded and not probe_only
                    state = ("UNSTABLE" if probe_only else "SLIP") if exceeded else "OK"
                    result.update(after=after, diff=diff, step_diff=step_diff,
                                  slipped=slipped, status=state)
                    line = ("%s ACCEL=%s VEL=%s BEFORE=%.5f AFTER=%.5f "
                            "DIFF=%+.5f STEP_DIFF=%+.5f mm TOL=%.3f -> %s"
                            % (tag, accel, None if probe_only else velocity,
                               reference, after, diff, step_diff, tolerance, state))
                    previous = after
                self.results.append(result)
                self.last_result = result
                gcmd.respond_info(line)
                if slipped or measurement_failed:
                    break
            failed = False
        finally:
            self.running = False
            self.bpc.last_result = saved_bpc_result
            # No automatic carriage travel on failure. Keep the selected tool,
            # restore G-code modes/feed override and use that tool's offsets.
            cleanup_errors = []
            commands = [
                "SET_VELOCITY_LIMIT VELOCITY=%.6f ACCEL=%.6f" % (orig_velocity, orig_accel),
                "RESTORE_GCODE_STATE NAME=_AXIS_SLIP_OUTER MOVE=0",
            ]
            if self._prepared_tool is not None:
                commands.append("BED_PIN_APPLY_OFFSET TOOL=" + self._prepared_tool)
            else:
                commands.append("SET_GCODE_OFFSET X=0 Y=0 Z=0 MOVE=0")
            for command in commands:
                try:
                    self.gcode.run_script_from_command(command)
                except Exception:
                    cleanup_errors.append(command)
                    logging.exception("axis_slip_test: cleanup failed: %s", command)
            if failed or slipped or measurement_failed or cleanup_errors:
                self._mark_unhomed(axis)
                gcmd.respond_info("Test stopped or position uncertain. Run G28 before further motion.")
            if cleanup_errors:
                gcmd.respond_info("Cleanup incomplete; restart and home before use.")
            if self._prepared_tool is not None:
                gcmd.respond_info("Selected tool remains %s; its stored bed-pin offsets were requested."
                                  % self._prepared_tool)

    def cmd_AXIS_SLIP_TEST(self, gcmd):
        accel = gcmd.get_float("ACCEL", 7000.0, above=0.)
        self._run(gcmd, "AXIS_SLIP_TEST", [accel])

    def cmd_AXIS_SLIP_SWEEP(self, gcmd):
        start = gcmd.get_float("START", 4000.0, above=0.)
        end = gcmd.get_float("END", 12000.0, minval=start)
        step = gcmd.get_float("STEP", 1000.0, above=0.)
        if not all(math.isfinite(v) for v in (start, end, step)):
            raise gcmd.error("Sweep values must be finite")
        if (end - start) / step > 999:
            raise gcmd.error("Sweep is limited to 1000 stages")
        accels = []
        accel = start
        while accel <= end + 1e-6:
            accels.append(accel)
            accel += step
        self._run(gcmd, "AXIS_SLIP_SWEEP", accels)


def load_config(config):
    return AxisSlipTest(config)
```

## quadro_bed_mesh.py
```python
class AveragedProbeResult:
    def __init__(self, bed_x, bed_y, bed_z):
        self.bed_x = bed_x
        self.bed_y = bed_y
        self.bed_z = bed_z


class QuadroBedMesh:
    def __init__(self, config):
        self.printer = config.get_printer()
        self.reactor = self.printer.get_reactor()
        self.gcode = self.printer.lookup_object("gcode")

        self.gcode.register_command(
            "QUADRO_CUSTOM_BED_MESH",
            self.cmd_QUADRO_CUSTOM_BED_MESH,
            desc="Quadro bed mesh calibration with repeated probing and averaging"
        )

    def cmd_QUADRO_CUSTOM_BED_MESH(self, gcmd):
        bedmesh = self.printer.lookup_object("bed_mesh")
        bmc = bedmesh.bmc
        probe = self.printer.lookup_object("probe")
        toolhead = self.printer.lookup_object("toolhead")

        # ------------------------------------------------------------
        # Profile
        # ------------------------------------------------------------
        profile_name = gcmd.get("PROFILE", "default")

        if not profile_name.strip():
            raise gcmd.error(
                "Value for parameter 'PROFILE' must be specified"
            )

        # ------------------------------------------------------------
        # Number of complete mesh passes
        #
        # Default:
        # 2 complete 9x9 meshes
        #
        # Example:
        #
        # QUADRO_CUSTOM_BED_MESH PROFILE=default
        #
        # -> 2 complete meshes
        # -> point-by-point average
        # -> one final averaged Klipper mesh
        #
        # Optional:
        #
        # QUADRO_CUSTOM_BED_MESH PROFILE=test REPEATS=3
        # ------------------------------------------------------------
        repeats = gcmd.get_int(
            "REPEATS",
            2,
            minval=1
        )

        # ------------------------------------------------------------
        # Remove currently active mesh
        # ------------------------------------------------------------
        bedmesh.set_mesh(None)

        # ------------------------------------------------------------
        # Let Klipper's original bed_mesh code prepare:
        #
        # mesh_min
        # mesh_max
        # probe_count
        # algorithm
        # faulty regions
        # zero_reference_position
        # etc.
        # ------------------------------------------------------------
        bmc._profile_name = profile_name

        try:
            bmc.update_config(gcmd)

        except Exception as e:
            raise gcmd.error(str(e))

        probe_mgr = bmc.probe_mgr
        probe_helper = probe_mgr.probe_helper

        # ------------------------------------------------------------
        # Exact standard bed_mesh probing path
        # ------------------------------------------------------------
        probe_path = list(
            probe_mgr.get_std_path()
        )

        if not probe_path:
            raise gcmd.error(
                "No bed mesh probe points generated"
            )

        # ------------------------------------------------------------
        # Probe parameters
        # ------------------------------------------------------------
        probe_params = probe.get_probe_params(gcmd)
        offsets = probe.get_offsets(gcmd)

        x_offset = offsets[0]
        y_offset = offsets[1]
        z_offset = offsets[2]

        mesh_speed = probe_helper.speed
        lift_speed = probe_params["lift_speed"]

        horizontal_move_z = gcmd.get_float(
            "HORIZONTAL_MOVE_Z",
            probe_helper.default_horizontal_move_z
        )

        if horizontal_move_z < z_offset:
            raise gcmd.error(
                "horizontal_move_z can't be less than probe's z_offset"
            )

        # ------------------------------------------------------------
        # Build a separate gcmd for actual physical probing
        #
        # Important:
        #
        # SAMPLES=1
        #
        # We do NOT want Klipper to average samples here.
        # We are averaging complete mesh passes ourselves.
        # ------------------------------------------------------------
        probe_cmd_params = dict(
            gcmd.get_command_parameters()
        )

        probe_cmd_params["SAMPLES"] = "1"

        # REPEATS belongs only to this custom plugin.
        # Do not pass it into the normal probe logic.
        probe_cmd_params.pop(
            "REPEATS",
            None
        )

        probe_gcmd = self.gcode.create_gcode_command(
            "QUADRO_CUSTOM_BED_MESH",
            "QUADRO_CUSTOM_BED_MESH",
            probe_cmd_params
        )

        # ------------------------------------------------------------
        # Result structure:
        #
        # all_pass_results = [
        #     [
        #         point1_result,
        #         point2_result,
        #         ...
        #     ],
        #     [
        #         point1_result,
        #         point2_result,
        #         ...
        #     ]
        # ]
        # ------------------------------------------------------------
        all_pass_results = []

        probe_session = None

        try:
            # --------------------------------------------------------
            # Start ONE probe session for all complete passes
            # --------------------------------------------------------
            probe_session = probe.start_probe_session(
                probe_gcmd
            )

            total_points = len(probe_path)

            # ========================================================
            # COMPLETE MESH PASSES
            # ========================================================
            for pass_index in range(repeats):

                gcmd.respond_info(
                    "===== QUADRO MESH PASS %d/%d ====="
                    % (
                        pass_index + 1,
                        repeats
                    )
                )

                pass_results = []

                # ====================================================
                # ALL POINTS IN THIS PASS
                # ====================================================
                for index, point in enumerate(probe_path):

                    # ------------------------------------------------
                    # 1. Raise Z to safe mesh travel height
                    # ------------------------------------------------
                    current = list(
                        toolhead.get_position()
                    )

                    current[2] = horizontal_move_z

                    # Same idea as ProbePointsHelper:
                    # first move may use mesh speed,
                    # subsequent raises use lift speed.
                    if index == 0:
                        raise_speed = mesh_speed
                    else:
                        raise_speed = lift_speed

                    toolhead.manual_move(
                        current,
                        raise_speed
                    )

                    toolhead.wait_moves()

                    # ------------------------------------------------
                    # 2. Move XY to actual probe/nozzle position
                    #
                    # bed_mesh uses probe offsets:
                    #
                    # machine target =
                    # mesh point - probe offset
                    # ------------------------------------------------
                    target_x = (
                        point[0] - x_offset
                    )

                    target_y = (
                        point[1] - y_offset
                    )

                    current = list(
                        toolhead.get_position()
                    )

                    current[0] = target_x
                    current[1] = target_y

                    toolhead.manual_move(
                        current,
                        mesh_speed
                    )

                    # Absolutely complete XY movement
                    # before settle/tare.
                    toolhead.wait_moves()

                    # ------------------------------------------------
                    # 3. Mechanical settle BEFORE manual tare
                    #
                    # 250 ms
                    # ------------------------------------------------
                    self.reactor.pause(
                        self.reactor.monotonic()
                        + 0.25
                    )

                    # ------------------------------------------------
                    # 4. Manual load cell tare
                    #
                    # IMPORTANT:
                    #
                    # load_cell_probe still performs its own
                    # automatic tare inside run_probe().
                    #
                    # Therefore this intentionally performs:
                    #
                    # manual tare
                    # +
                    # automatic tare
                    #
                    # This is the double-tare method we are testing.
                    # ------------------------------------------------
                    self.gcode.run_script_from_command(
                        "load_cell_tare "
                        "load_cell=load_cell_probe"
                    )

                    # ------------------------------------------------
                    # 5. Settle AFTER manual tare
                    #
                    # 250 ms
                    # ------------------------------------------------
                    self.reactor.pause(
                        self.reactor.monotonic()
                        + 0.25
                    )

                    # ------------------------------------------------
                    # Console status
                    # ------------------------------------------------
                    gcmd.respond_info(
                        "Quadro mesh pass %d/%d "
                        "point %d/%d: "
                        "X=%.2f Y=%.2f"
                        % (
                            pass_index + 1,
                            repeats,
                            index + 1,
                            total_points,
                            point[0],
                            point[1]
                        )
                    )

                    # ------------------------------------------------
                    # 6. ONE physical probe
                    #
                    # SAMPLES=1
                    #
                    # load_cell_probe's internal automatic tare
                    # still happens here.
                    # ------------------------------------------------
                    probe_session.run_probe(
                        probe_gcmd
                    )

                    point_results = (
                        probe_session.pull_probed_results()
                    )

                    # ------------------------------------------------
                    # Every mesh point must return exactly
                    # one result.
                    # ------------------------------------------------
                    if len(point_results) != 1:
                        raise gcmd.error(
                            "Unexpected probe result count "
                            "at pass %d point %d: %d"
                            % (
                                pass_index + 1,
                                index + 1,
                                len(point_results)
                            )
                        )

                    pass_results.append(
                        point_results[0]
                    )

                # ----------------------------------------------------
                # Complete pass finished.
                # Raise Z to safe travel height.
                # ----------------------------------------------------
                current = list(
                    toolhead.get_position()
                )

                current[2] = horizontal_move_z

                toolhead.manual_move(
                    current,
                    lift_speed
                )

                toolhead.wait_moves()

                # Save the whole completed pass
                all_pass_results.append(
                    pass_results
                )

                gcmd.respond_info(
                    "===== QUADRO MESH PASS "
                    "%d/%d COMPLETE ====="
                    % (
                        pass_index + 1,
                        repeats
                    )
                )

        finally:
            if probe_session is not None:
                probe_session.end_probe_session()

        # ============================================================
        # VALIDATE COMPLETE PASS COUNT
        # ============================================================
        if len(all_pass_results) != repeats:
            raise gcmd.error(
                "Expected %d mesh passes "
                "but received %d"
                % (
                    repeats,
                    len(all_pass_results)
                )
            )

        # ------------------------------------------------------------
        # Also ensure every pass contains the
        # expected number of probe results.
        # ------------------------------------------------------------
        total_points = len(probe_path)

        for pass_index, pass_results in enumerate(
            all_pass_results
        ):
            if len(pass_results) != total_points:
                raise gcmd.error(
                    "Mesh pass %d expected %d points "
                    "but received %d"
                    % (
                        pass_index + 1,
                        total_points,
                        len(pass_results)
                    )
                )

        # ============================================================
        # AVERAGE COMPLETE MESH PASSES
        # ============================================================
        averaged_results = []

        gcmd.respond_info(
            "===== CALCULATING AVERAGE "
            "OF %d MESH PASSES ====="
            % repeats
        )

        for point_index in range(total_points):

            # --------------------------------------------------------
            # X/Y reference is taken from first pass.
            #
            # All passes use the exact same bed_mesh path.
            # --------------------------------------------------------
            first_result = (
                all_pass_results[0][point_index]
            )

            z_sum = 0.0
            z_values = []

            # --------------------------------------------------------
            # Add the bed_z value from each complete pass
            # --------------------------------------------------------
            for pass_index in range(repeats):

                probe_result = (
                    all_pass_results
                    [pass_index]
                    [point_index]
                )

                z_sum += probe_result.bed_z

                z_values.append(
                    "%.6f"
                    % probe_result.bed_z
                )

            # --------------------------------------------------------
            # Final Z average for this exact XY point
            # --------------------------------------------------------
            average_z = (
                z_sum / float(repeats)
            )

            # --------------------------------------------------------
            # IMPORTANT:
            #
            # BedMeshCalibrate.probe_finalize()
            # expects OBJECTS containing:
            #
            # .bed_x
            # .bed_y
            # .bed_z
            #
            # It does NOT accept plain tuple/list here.
            #
            # That was the cause of the previous
            # Internal error.
            # --------------------------------------------------------
            averaged_result = AveragedProbeResult(
                first_result.bed_x,
                first_result.bed_y,
                average_z
            )

            averaged_results.append(
                averaged_result
            )

            # --------------------------------------------------------
            # Console output:
            #
            # Example:
            #
            # Average point 41/81
            # X=150 Y=150
            # -0.020000 / -0.021875
            # -> AVG=-0.020937
            # --------------------------------------------------------
            gcmd.respond_info(
                "Average point %d/%d "
                "X=%.2f Y=%.2f: "
                "%s -> AVG=%.6f"
                % (
                    point_index + 1,
                    total_points,
                    first_result.bed_x,
                    first_result.bed_y,
                    " / ".join(z_values),
                    average_z
                )
            )

        # ============================================================
        # FINALIZE THE AVERAGED MESH
        #
        # We pass ONLY the final averaged results
        # to Klipper's original bed_mesh logic.
        #
        # Klipper then performs:
        #
        # - bed_x / bed_y / bed_z conversion
        # - faulty-region handling
        # - point count validation
        # - probed matrix creation
        # - X/Y row orientation
        # - zero reference handling
        # - ZMesh creation
        # - bicubic interpolation
        # - mesh activation
        # - profile saving
        # ============================================================
        bmc.probe_finalize(
            averaged_results
        )

        # ------------------------------------------------------------
        # Final console message
        # ------------------------------------------------------------
        gcmd.respond_info(
            "QUADRO_CUSTOM_BED_MESH complete. "
            "PROFILE=%s REPEATS=%d "
            "- averaged mesh saved."
            % (
                profile_name,
                repeats
            )
        )


def load_config(config):
    return QuadroBedMesh(config)
```

# Source: printer configuration and macros (printer_data/config, wiring removed)

## printer.cfg
```
[include mainsail.cfg]
[include chroma_head_1.cfg]
[include chroma_head_2.cfg]
[include chroma_head_3.cfg]
[include chroma_head_4.cfg]
[include input_shaper.cfg]
[include tool_map.cfg]
[include calibration_wizard.cfg]
[include cp_macro.cfg]
[include cp_macro_2.cfg]
[include purge_filament_macros.cfg]
#[include ext-bed.cfg]
[include leds.cfg]
#[include steppers.cfg]

[include timelapse.cfg]


[mcu]
restart_method: command

[temperature_sensor main_temp]
sensor_type: temperature_mcu
sensor_mcu: mcu
min_temp: 0
max_temp: 75


[printer]
kinematics: generic_cartesian
max_velocity: 500
max_accel: 10000
max_z_velocity: 20
max_z_accel: 500

# max_z_velocity: 5
# max_z_accel: 50

square_corner_velocity: 5.0

[temperature_sensor Host_PC]
sensor_type: temperature_host


[stepper stepper_t0]
carriages: carriage_t0
microsteps: 16
rotation_distance: 40


[tmc2209 stepper stepper_t0]
uart_address:0
driver_SGTHRS: 130
# interpolate: True
# run_current: 0.65
# hold_current: 0.3
# sense_resistor: 0.110
# stealthchop_threshold: 0

interpolate: True
run_current: 1
# hold_current: 0.8
sense_resistor: 0.100
stealthchop_threshold: 0
# driver_TBL: 1
# driver_TOFF: 4
# driver_HSTRT: 4
# driver_HEND: 3


[carriage carriage_t0]
axis: x
position_endstop: -169
position_min: -169
position_max: 303.25
homing_speed: 60

#safe_distance: 0
homing_retract_dist: 0
homing_positive_dir: False


[tmc2209 stepper stepper_t1]
uart_address:1
driver_SGTHRS: 130
# interpolate: True
# run_current: 0.65
# hold_current: 0.3
# sense_resistor: 0.110
# stealthchop_threshold: 0
interpolate: True
run_current: 1
# hold_current: 0.8
sense_resistor: 0.100
stealthchop_threshold: 0
# driver_TBL: 1
# driver_TOFF: 4
# driver_HSTRT: 4
# driver_HEND: 3

[stepper stepper_t1]
carriages: carriage_t1
microsteps: 16
rotation_distance: 40

[dual_carriage carriage_t1]
primary_carriage: carriage_t0
axis: x
position_endstop: -112.75
position_min: -112.75
position_max: 359.50
safe_distance: 0
homing_speed: 60
# second_homing_speed:20
homing_retract_dist: 0
homing_retract_speed: 20
homing_positive_dir: False





[tmc2209 stepper stepper_t2]
uart_address:2
driver_SGTHRS: 130
# interpolate: True
# run_current: 0.65
# hold_current: 0.3
# sense_resistor: 0.110
# stealthchop_threshold: 0
interpolate: True
run_current: 1
# hold_current: 0.8
sense_resistor: 0.100
stealthchop_threshold: 0
# driver_TBL: 1
# driver_TOFF: 4
# driver_HSTRT: 4
# driver_HEND: 3

[stepper stepper_t2]
carriages: carriage_t2
microsteps: 16
rotation_distance: 40

[dual_carriage carriage_t2]
#primary_carriage: carriage_t0
axis: x
position_endstop: 412.75
position_min: -59.50 
position_max: 412.75
#safe_distance: 0
homing_speed: 60
#second_homing_speed:20
homing_retract_dist: 0
homing_retract_speed: 20
homing_positive_dir: True


[tmc2209 stepper stepper_t3]
uart_address:3
driver_SGTHRS: 130
# interpolate: True
# run_current: 0.65
# hold_current: 0.3
# sense_resistor: 0.110
# stealthchop_threshold: 0
interpolate: True
run_current: 1
# hold_current: 0.8
sense_resistor: 0.100
stealthchop_threshold: 0
# driver_TBL: 1
# driver_TOFF: 4
# driver_HSTRT: 4
# driver_HEND: 3

[stepper stepper_t3]
carriages: carriage_t3
microsteps: 16
rotation_distance: 40

[dual_carriage carriage_t3]
primary_carriage: carriage_t2
axis: x
position_endstop: 469
position_min: -3.25
position_max:469
safe_distance: 0
homing_speed: 60
#second_homing_speed:20
homing_retract_dist: 0
homing_positive_dir: True





[carriage carriage_y] 
axis: y
position_endstop: -1
position_min: -1
position_max: 318
homing_speed: 60
homing_retract_dist:0





[stepper stepper_y2]
carriages: carriage_y
microsteps: 16
rotation_distance: 40


[tmc2209 stepper stepper_y2]
driver_SGTHRS: 60
uart_address:1
# interpolate: false
# run_current:1.5
# sense_resistor: 0.10
# stealthchop_threshold: 0

interpolate: True
run_current: 1.3

sense_resistor: 0.100
#stealthchop_threshold: 999999
stealthchop_threshold: 0

# driver_TBL: 1
# driver_TOFF: 2
# driver_HEND: 2
# driver_HSTRT: 4
# driver_TBL: 1          # Blank time (Genelde 1-2 yeterlidir)
# driver_TOFF: 4         # 24V sistemlerde 3 veya 4 hız/tork dengesi için idealdir
# driver_HSTRT: 5        # Hysteresis start
# driver_HEND: 3         # Hysteresis end

[stepper stepper_y1]
carriages: carriage_y
microsteps: 16
rotation_distance: 40
# position_endstop: 0
# position_min: 0
# position_max: 305
# homing_speed: 30
# homing_retract_dist:0


[tmc2209 stepper stepper_y1]
driver_SGTHRS: 60
uart_address:0

# interpolate: false
# run_current:1.5
# # hold_current:0.5
# sense_resistor: 0.10
# stealthchop_threshold: 0

interpolate: True
run_current: 1.3

sense_resistor: 0.100
#stealthchop_threshold: 999999
stealthchop_threshold: 0


# driver_TBL: 1
# driver_TOFF: 2
# driver_HEND: 2
# driver_HSTRT: 4
# driver_TBL: 1          # Blank time (Genelde 1-2 yeterlidir)
# driver_TOFF: 4         # 24V sistemlerde 3 veya 4 hız/tork dengesi için idealdir
# driver_HSTRT: 5        # Hysteresis start
# driver_HEND: 3         # Hysteresis end


[carriage carriage_z]
axis: z
position_max: 310
position_min: -5
position_endstop:0
homing_speed: 5
homing_retract_dist:0 


[stepper stepper_z]
carriages: carriage_z
microsteps: 16
rotation_distance:4
#position_endstop: 330
# position_min: -5
# position_max: 335
# homing_speed: 30 #60
# homing_retract_dist:0 #10


[tmc2209 stepper stepper_z]
# driver_SGTHRS: 95
uart_address:2

# interpolate: true
# run_current:1.5
# # hold_current:0.5
# sense_resistor: 0.10
# stealthchop_threshold: 0

interpolate: False
run_current: 1.2

sense_resistor: 0.100
stealthchop_threshold: 0


# driver_TBL: 0
# driver_TOFF: 1
# driver_HEND: 12
# driver_HSTRT: 7

# [input_shaper]
# shaper_type_x: zv
# shaper_freq_x: 52.2
# shaper_type_y: zv
# shaper_freq_y: 54.4
# 1. Kural: Dokümantasyonun dediği gibi başlık duracak ama içi boş olacak!

[quadro_input_shaper]
carriages: carriage_t0,carriage_t1,carriage_t2,carriage_t3
change_cmd_carriage_t0: T0
change_cmd_carriage_t1: T1
change_cmd_carriage_t2: T2
change_cmd_carriage_t3: T3
chip_carriage_t0: t0
chip_carriage_t1: t1
chip_carriage_t2: t2
chip_carriage_t3: t3

[input_shaper]

# 2. Kural: Bütün kafaları ve ortak Y eksenini boot anında tanımlıyoruz
[delayed_gcode init_shaper]
initial_duration: 0.1
gcode:
  {% set s = printer.quadro_input_shaper %}
  {% for c in ['carriage_t3', 'carriage_t2', 'carriage_t1', 'carriage_t0'] %}
    {% set has_x = ('shaper_freq_x_' ~ c) in s %}
    {% set has_y = 'shaper_freq_y' in s %}
    {% if has_x or has_y %}
      SET_DUAL_CARRIAGE CARRIAGE={c}
      SET_INPUT_SHAPER{% if has_x %} SHAPER_TYPE_X={s['shaper_type_x_' ~ c]} SHAPER_FREQ_X={s['shaper_freq_x_' ~ c]|float}{% endif %}{% if has_y %} SHAPER_TYPE_Y={s['shaper_type_y']} SHAPER_FREQ_Y={s['shaper_freq_y']|float}{% endif %}
    {% endif %}
  {% endfor %}
  
#[delayed_gcode init_shaper]
#initial_duration: 0.1
#gcode:
  # T0 Kafası + Ortak Y Tanımı
#  SET_DUAL_CARRIAGE CARRIAGE=carriage_t0
#  SET_INPUT_SHAPER SHAPER_TYPE_X=mzv SHAPER_FREQ_X=60.0 SHAPER_TYPE_Y=mzv SHAPER_FREQ_Y=46.4
  
  # T1 Kafası + Ortak Y Tanımı (Y doküman gereği aynı kalmalı)
#  SET_DUAL_CARRIAGE CARRIAGE=carriage_t1
#  SET_INPUT_SHAPER SHAPER_TYPE_X=mzv SHAPER_FREQ_X=60.0 SHAPER_TYPE_Y=mzv SHAPER_FREQ_Y=46.4
  
  # T2 Kafası + Ortak Y Tanımı
#  SET_DUAL_CARRIAGE CARRIAGE=carriage_t2
#  SET_INPUT_SHAPER SHAPER_TYPE_X=mzv SHAPER_FREQ_X=60.0 SHAPER_TYPE_Y=mzv SHAPER_FREQ_Y=46.4
  
  # T3 Kafası + Ortak Y Tanımı
#  SET_DUAL_CARRIAGE CARRIAGE=carriage_t3
#  SET_INPUT_SHAPER SHAPER_TYPE_X=mzv SHAPER_FREQ_X=60.0 SHAPER_TYPE_Y=mzv SHAPER_FREQ_Y=46.4
  
  # Makineyi en son T0 aktif olacak şekilde bırakalım
#  SET_DUAL_CARRIAGE CARRIAGE=carriage_t0




# z_offset = -0.025

[save_variables]
filename: ~/printer_data/config/variables.cfg

[pa_autotune]

[heater_bed]
sensor_type: EPCOS 100K B57560G104F
# control: watermark#pid
control: pid
# pid_kp = 72.873
# pid_ki = 0.724
# pid_kd = 1833.663
pid_Kp: 56.700 
pid_Ki: 1.178 
pid_Kd: 682.530
min_temp: -15
max_temp: 105

[output_pin driver_fan]
pwm: 1
value:1
cycle_time: 3

[output_pin driver_fan2]
pwm: 1
value:1
cycle_time: 3

#*# <---------------------- SAVE_CONFIG ---------------------->
#*# DO NOT EDIT THIS BLOCK OR BELOW. The contents are auto-generated.
#*#
#*# [probe]
#*# z_offset = 1.025
#*#
#*# [bed_mesh default]
#*# version = 1
#*# points =
#*# 	  -0.451250, -0.312500, -0.241250, -0.202500, -0.160000, -0.137500, -0.093750, -0.028750, -0.062500
#*# 	  -0.263125, -0.138750, -0.102500, -0.073125, -0.055000, -0.036250, -0.031250, -0.033125, -0.071875
#*# 	  -0.110625, -0.039375, 0.003750, 0.003125, 0.026875, 0.025625, -0.006250, -0.045000, -0.144375
#*# 	  -0.069375, 0.022500, 0.020625, 0.021875, 0.023750, 0.003125, -0.015000, -0.106250, -0.210625
#*# 	  -0.069375, -0.031875, 0.004375, -0.013750, 0.000000, -0.026875, -0.046875, -0.153125, -0.322500
#*# 	  -0.096250, -0.062500, -0.054375, -0.052500, -0.046875, -0.056250, -0.125625, -0.235000, -0.419375
#*# 	  -0.191250, -0.171250, -0.189375, -0.181250, -0.150625, -0.163750, -0.234375, -0.346250, -0.559375
#*# 	  -0.338125, -0.338750, -0.340625, -0.318750, -0.304375, -0.283125, -0.330000, -0.485625, -0.686250
#*# 	  -0.445625, -0.443125, -0.453125, -0.451250, -0.396250, -0.404375, -0.446875, -0.578125, -0.756875
#*# x_count = 9
#*# y_count = 9
#*# mesh_x_pps = 2
#*# mesh_y_pps = 2
#*# algo = bicubic
#*# tension = 0.2
#*# min_x = 5.0
#*# max_x = 295.0
#*# min_y = 5.0
#*# max_y = 295.0
#*#
#*# [quadro_input_shaper]
#*# shaper_type_x_carriage_t0 = mzv
#*# shaper_freq_x_carriage_t0 = 53.0
#*# shaper_type_y = ei
#*# shaper_freq_y = 51.2
#*# shaper_type_x_carriage_t1 = mzv
#*# shaper_freq_x_carriage_t1 = 46.2
#*# shaper_type_x_carriage_t2 = mzv
#*# shaper_freq_x_carriage_t2 = 51.8
#*# shaper_type_x_carriage_t3 = mzv
#*# shaper_freq_x_carriage_t3 = 49.6
```

## tool_map.cfg
```
# Kullanım Şekli 
# KCM'li chazlarda kullanım için Tool macrolarını devre dışı bırakınız.
# SET_TOOL_MAP LOGICAL=0 PHYSICAL=3


[gcode_macro TOOL_MAP]
variable_map: {0: 0, 1: 1, 2: 2, 3: 3}
gcode:


[gcode_macro _ACTIVATE_LOGICAL_TOOL]
gcode:
    {% set logical = params.LOGICAL|int %}
    {% set toolmap = printer["gcode_macro TOOL_MAP"].map %}
    {% set slot = toolmap[logical] %}
    {% set msg = "T" ~ logical ~ " -> SLOT " ~ slot %}
    RESPOND PREFIX=TEST MSG="{msg}"

[gcode_macro T0]
gcode:
    {% set p = printer["gcode_macro TOOL_MAP"].map[0] %}
    {% if p == 0 %} PHYS_TOOL_0 {rawparams}
    {% elif p == 1 %} PHYS_TOOL_1 {rawparams}
    {% elif p == 2 %} PHYS_TOOL_2 {rawparams}
    {% elif p == 3 %} PHYS_TOOL_3 {rawparams}
    {% endif %}

[gcode_macro T1]
gcode:
    {% set p = printer["gcode_macro TOOL_MAP"].map[1] %}
    {% if p == 0 %} PHYS_TOOL_0 {rawparams}
    {% elif p == 1 %} PHYS_TOOL_1 {rawparams}
    {% elif p == 2 %} PHYS_TOOL_2 {rawparams}
    {% elif p == 3 %} PHYS_TOOL_3 {rawparams}
    {% endif %}


[gcode_macro T2]
gcode:
    {% set p = printer["gcode_macro TOOL_MAP"].map[2] %}
    {% if p == 0 %} PHYS_TOOL_0 {rawparams}
    {% elif p == 1 %} PHYS_TOOL_1 {rawparams}
    {% elif p == 2 %} PHYS_TOOL_2 {rawparams}
    {% elif p == 3 %} PHYS_TOOL_3 {rawparams}
    {% endif %}


[gcode_macro T3]
gcode:
    {% set p = printer["gcode_macro TOOL_MAP"].map[3] %}
    {% if p == 0 %} PHYS_TOOL_0 {rawparams}
    {% elif p == 1 %} PHYS_TOOL_1 {rawparams}
    {% elif p == 2 %} PHYS_TOOL_2 {rawparams}
    {% elif p == 3 %} PHYS_TOOL_3 {rawparams}
    {% endif %}

[gcode_macro SET_TOOL_MAP]
gcode:
    {% set logical = params.LOGICAL|int %}
    {% set physical = params.PHYSICAL|int %}

    {% if logical not in [0,1,2,3] %}
        {action_raise_error("Invalid logical tool")}
    {% endif %}

    {% if physical not in [0,1,2,3] %}
        {action_raise_error("Invalid physical tool")}
    {% endif %}

    {% set current = printer["gcode_macro TOOL_MAP"].map %}
    {% set newmap = dict(current) %}
    {% set _ = newmap.update({logical: physical}) %}

    SET_GCODE_VARIABLE MACRO=TOOL_MAP VARIABLE=map VALUE="{newmap}"




[gcode_macro PHYS_TOOL_0]
gcode:
    {% set active = printer.toolhead.extruder %}

    {% if active == "extruder1" %}
        one_T0 {rawparams}
    {% elif active == "extruder2" %}
        two_T0 {rawparams}
    {% elif active == "extruder3" %}
        three_T0 {rawparams}
    {% elif active == "extruder" %}
        RESPOND MSG="Already on T0"
    {% endif %}

    G1 F18000

[gcode_macro PHYS_TOOL_1]
gcode:
    {% set active = printer.toolhead.extruder %}

    {% if active == "extruder" %}
        zero_T1 {rawparams}
    {% elif active == "extruder2" %}
        two_T1 {rawparams}
    {% elif active == "extruder3" %}
        three_T1 {rawparams}
    {% elif active == "extruder1" %}
        RESPOND MSG="Already on T1"
    {% endif %}

    G1 F18000
    
[gcode_macro PHYS_TOOL_2]
gcode:
    {% set active = printer.toolhead.extruder %}

    {% if active == "extruder" %}
        zero_T2 {rawparams}
    {% elif active == "extruder1" %}
        one_T2 {rawparams}
    {% elif active == "extruder3" %}
        three_T2 {rawparams}
    {% elif active == "extruder2" %}
        RESPOND MSG="Already on T2"
    {% endif %}

    G1 F18000

    
[gcode_macro PHYS_TOOL_3]
gcode:
    {% set active = printer.toolhead.extruder %}

    {% if active == "extruder" %}
        zero_T3 {rawparams}
    {% elif active == "extruder1" %}
        one_T3 {rawparams}
    {% elif active == "extruder2" %}
        two_T3 {rawparams}
    {% elif active == "extruder3" %}
        RESPOND MSG="Already on T3"
    {% endif %}

    G1 F18000




[gcode_macro M1066]
gcode:
  {% set tool = params.T|default(1)|int %}
  {% set speed = params.S|default(0)|float %}

  SET_FAN_SPEED FAN={"fan" ~ tool} SPEED={speed}


[gcode_macro T_ALL_FAN]
gcode:
  {% set speed = params.SPEED|default(0)|float %}
  SET_FAN_SPEED FAN=fan1 SPEED={speed}
  SET_FAN_SPEED FAN=fan2 SPEED={speed}
  SET_FAN_SPEED FAN=fan3 SPEED={speed}
  SET_FAN_SPEED FAN=fan4 SPEED={speed}

[gcode_macro T_ALL_TEMP]
gcode:
    {% set temp = params.TEMP|default(params.S|default(0))|float %}
    M104 T0 S{temp}
    M104 T1 S{temp}
    M104 T2 S{temp}
    M104 T3 S{temp}
```

## cp_macro.cfg
```
[force_move]
enable_force_move: True


[gcode_macro TEST_BED_PIN_STATUS]
gcode:
    RESPOND MSG="{printer['bed_pin_calibration']}"


[gcode_macro _SAFE_Z_LIFT_BEFORE_HOME]
gcode:
    {% if 'z' in printer.toolhead.homed_axes %}
        G91
        G1 Z5 F300
        G90
    {% else %}
        SET_KINEMATIC_POSITION Z=0
        G91
        G1 Z5 F300
        G90
    {% endif %}

[gcode_macro _HOME_Z_FROM_LAST_PROBE]
gcode:
    {% set z_probed = printer.probe.last_probe_position.z %}
    {% set z_position = printer.toolhead.position[2] %}
    {% set z_offset = 0.015 %}
    {% set z_actual = z_position - z_probed - z_offset %}
    SET_KINEMATIC_POSITION Z={z_actual}

[gcode_macro _HOME_Z]
gcode:
    SET_GCODE_OFFSET Z=0  # load cell probes dont need a Z offset
    # position toolhead for homing Z, edit for your printers size
    #G90  # absolute move
    #G1 Y50 X50 F{5 * 60}  # move to X/Y position for homing

    # soft home the z axis to its limit so it can be moved:
    SET_KINEMATIC_POSITION Z={printer.toolhead.axis_maximum[2]}

    # Fast approach and tap
    PROBE PROBE_SPEED=5  # override the speed for faster homing
    _HOME_Z_FROM_LAST_PROBE

    # lift z to 2mm
    G91  # relative move
    G1 Z2 F{5 * 60}

    # probe at standard speed
    PROBE
    _HOME_Z_FROM_LAST_PROBE

    # lift z to 10mm for clearance
    G91  # relative move
    G1 Z10 F{5 * 60}


[gcode_macro QUADRO_HOME]
gcode:
    G90

    G28 X
    G28 Y

    QUADRO_DISTRIBUTE_X

    G1 X150 Y150 F6000

    _HOME_Z



[gcode_macro QUADRO_DISTRIBUTE_X_HOME_PRELOAD]
gcode:
    G90


    SET_DUAL_CARRIAGE CARRIAGE=carriage_t2
    G1 X372 F6000
    SET_DUAL_CARRIAGE CARRIAGE=carriage_t3
    G1 X449 F6000
    SET_DUAL_CARRIAGE CARRIAGE=carriage_t1
    G1 X-72 F6000
    SET_DUAL_CARRIAGE CARRIAGE=carriage_t0
    G1 X-149 F6000
    G4 P2000
    # M84 X
    

[gcode_macro QUADRO_DISTRIBUTE_X]
gcode:
    G90

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t3
    G1 X469 F9000

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t2
    G1 X412.75 F9000

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t1
    # G1 X356.50 F9000

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t0
    # G1 X150 F9000

    # Sadece T0 ve T1'i aynı anda dağıt.
    QUADRO_PARALLEL_MOVE T0=150 T1=356.50 SPEED=300

    # Sonraki Z home için T0 aktif kalsın
    SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY




# [gcode_macro _HOME_X]
# gcode:
#     SET_VELOCITY_LIMIT VELOCITY=500 ACCEL=5000
#     G28 X
#     QUADRO_DISTRIBUTE_X_HOME_PRELOAD
#     SET_VELOCITY_LIMIT VELOCITY=20
#     SET_TMC_FIELD STEPPER=stepper_t0 FIELD=SGTHRS VALUE=50
#     SET_TMC_FIELD STEPPER=stepper_t1 FIELD=SGTHRS VALUE=60
#     SET_TMC_FIELD STEPPER=stepper_t2 FIELD=SGTHRS VALUE=50
#     SET_TMC_FIELD STEPPER=stepper_t3 FIELD=SGTHRS VALUE=50
#     G28 X
#     SET_VELOCITY_LIMIT VELOCITY=500
#     SET_TMC_FIELD STEPPER=stepper_t0 FIELD=SGTHRS VALUE=130
#     SET_TMC_FIELD STEPPER=stepper_t1 FIELD=SGTHRS VALUE=130
#     SET_TMC_FIELD STEPPER=stepper_t2 FIELD=SGTHRS VALUE=130
#     SET_TMC_FIELD STEPPER=stepper_t3 FIELD=SGTHRS VALUE=130
#     QUADRO_DISTRIBUTE_X

[gcode_macro _HOME_X]
variable_fast_sgthrs_t0: 140
variable_fast_sgthrs_t1: 140
variable_fast_sgthrs_t2: 140
variable_fast_sgthrs_t3: 140
variable_slow_sgthrs_t0: 68
variable_slow_sgthrs_t1: 68
variable_slow_sgthrs_t2: 68
variable_slow_sgthrs_t3: 68
gcode:
    SET_VELOCITY_LIMIT VELOCITY=500 ACCEL=5000
    SET_TMC_FIELD STEPPER=stepper_t0 FIELD=SGTHRS VALUE={fast_sgthrs_t0}
    SET_TMC_FIELD STEPPER=stepper_t1 FIELD=SGTHRS VALUE={fast_sgthrs_t1}
    SET_TMC_FIELD STEPPER=stepper_t2 FIELD=SGTHRS VALUE={fast_sgthrs_t2}
    SET_TMC_FIELD STEPPER=stepper_t3 FIELD=SGTHRS VALUE={fast_sgthrs_t3}
    G28 X
    QUADRO_DISTRIBUTE_X_HOME_PRELOAD
    M400
    SET_TMC_FIELD STEPPER=stepper_t0 FIELD=intpol VALUE=0
    SET_TMC_FIELD STEPPER=stepper_t1 FIELD=intpol VALUE=0
    SET_TMC_FIELD STEPPER=stepper_t2 FIELD=intpol VALUE=0
    SET_TMC_FIELD STEPPER=stepper_t3 FIELD=intpol VALUE=0
    SET_VELOCITY_LIMIT VELOCITY=20
    SET_TMC_FIELD STEPPER=stepper_t0 FIELD=SGTHRS VALUE={slow_sgthrs_t0}
    SET_TMC_FIELD STEPPER=stepper_t1 FIELD=SGTHRS VALUE={slow_sgthrs_t1}
    SET_TMC_FIELD STEPPER=stepper_t2 FIELD=SGTHRS VALUE={slow_sgthrs_t2}
    SET_TMC_FIELD STEPPER=stepper_t3 FIELD=SGTHRS VALUE={slow_sgthrs_t3}
    M400
    G28 X
    M400
    SET_TMC_FIELD STEPPER=stepper_t0 FIELD=intpol VALUE=1
    SET_TMC_FIELD STEPPER=stepper_t1 FIELD=intpol VALUE=1
    SET_TMC_FIELD STEPPER=stepper_t2 FIELD=intpol VALUE=1
    SET_TMC_FIELD STEPPER=stepper_t3 FIELD=intpol VALUE=1
    SET_VELOCITY_LIMIT VELOCITY=500
    SET_TMC_FIELD STEPPER=stepper_t0 FIELD=SGTHRS VALUE=130
    SET_TMC_FIELD STEPPER=stepper_t1 FIELD=SGTHRS VALUE=130
    SET_TMC_FIELD STEPPER=stepper_t2 FIELD=SGTHRS VALUE=130
    SET_TMC_FIELD STEPPER=stepper_t3 FIELD=SGTHRS VALUE=130
    QUADRO_DISTRIBUTE_X


[gcode_macro QUADRO_CLEAR_OFFSETS_BEFORE_HOME]
gcode:
    SET_GCODE_OFFSET Z=0.000 MOVE=0
    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

[gcode_macro QUADRO_RESET_TOOL_AFTER_HOME]
gcode:
    SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
    SET_GCODE_OFFSET Z=0.000 MOVE=0
    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0
    ACTIVATE_EXTRUDER EXTRUDER=extruder
    # _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    RESPOND MSG="Home finished: reset active tool to T0"
    

# [gcode_macro _HOME_Y]
# gcode:
#     G28 Y
#     #G1 Y150 F6000



[gcode_macro _HOME_Y]
variable_fast_sgthrs: 120
variable_slow_sgthrs: 60
gcode:
    {% set previous_velocity = printer.toolhead.max_velocity|float %}
    {% set restore_sg1 = printer.configfile.settings["tmc2209 stepper stepper_y1"].driver_sgthrs|int %}
    {% set restore_sg2 = printer.configfile.settings["tmc2209 stepper stepper_y2"].driver_sgthrs|int %}

    G90
    SET_TMC_FIELD STEPPER=stepper_y1 FIELD=SGTHRS VALUE={fast_sgthrs}
    SET_TMC_FIELD STEPPER=stepper_y2 FIELD=SGTHRS VALUE={fast_sgthrs}
    G4 P1000
    G28 Y

    G1 Y9 F1200
    M400

    SET_VELOCITY_LIMIT VELOCITY=20
    SET_TMC_FIELD STEPPER=stepper_y1 FIELD=SGTHRS VALUE={slow_sgthrs}
    SET_TMC_FIELD STEPPER=stepper_y2 FIELD=SGTHRS VALUE={slow_sgthrs}
    G4 P2000
    G28 Y

    G1 Y9 F1200
    M400

    SET_TMC_FIELD STEPPER=stepper_y1 FIELD=SGTHRS VALUE={restore_sg1}
    SET_TMC_FIELD STEPPER=stepper_y2 FIELD=SGTHRS VALUE={restore_sg2}
    SET_VELOCITY_LIMIT VELOCITY={previous_velocity}


[homing_override]
axes: xyz
gcode:
    {% set shaper = printer.quadro_input_shaper %}
    {% set restore_y_freq = shaper.get('shaper_freq_y', 0.0)|float %}

    SET_INPUT_SHAPER SHAPER_FREQ_Y=0

    G90
    QUADRO_CLEAR_OFFSETS_BEFORE_HOME
    _SAFE_Z_LIFT_BEFORE_HOME

    {% if params.X is defined or params.Y is defined or params.Z is defined %}
        {% if params.X is defined %}
            _HOME_X
        {% endif %}

        {% if params.Y is defined %}
            _HOME_Y
        {% endif %}

        {% if params.Z is defined %}
            SET_DUAL_CARRIAGE CARRIAGE=carriage_t0
            G1 X150 Y150 F6000
            load_cell_tare load_cell=load_cell_probe
            G4 P1000
            _HOME_Z
        {% endif %}

        QUADRO_RESET_TOOL_AFTER_HOME
    {% else %}
        _HOME_X
        _HOME_Y
        SET_DUAL_CARRIAGE CARRIAGE=carriage_t0
        G1 X150 Y150 F6000
        load_cell_tare load_cell=load_cell_probe
        G4 P1000
        _HOME_Z
        QUADRO_RESET_TOOL_AFTER_HOME
    {% endif %}

    SET_TOOL_MAP LOGICAL=0 PHYSICAL=0
    SET_TOOL_MAP LOGICAL=1 PHYSICAL=1
    SET_TOOL_MAP LOGICAL=2 PHYSICAL=2
    SET_TOOL_MAP LOGICAL=3 PHYSICAL=3

    M400
    SET_INPUT_SHAPER SHAPER_FREQ_Y={restore_y_freq}


[gcode_macro TEST_BED_PIN_VALUE]
gcode:
    {% set lc = printer["load_cell bed_pin"] %}
    RESPOND MSG="LOAD CELL OBJ = {lc}"

[gcode_macro TEST_BED_PIN_FORCE]
gcode:
    {% set lc = printer["load_cell bed_pin"] %}
    RESPOND MSG="FORCE={lc.force_g}"

[gcode_macro BED_PIN_TOUCH_TEST]
gcode:
    G91
    G1 Z-0.02 F60
    G90

    LOAD_CELL_READ LOAD_CELL=bed_pin

    {% set lc = printer["load_cell bed_pin"] %}

    RESPOND MSG="FORCE={lc.force_g}"


[gcode_macro BED_PIN_TOUCH_AUTO]
gcode:
    {% set lc = printer["load_cell bed_pin"] %}

    {% if lc.force_g < 60 %}
        G91
        G1 Z-0.02 F300
        G90

        LOAD_CELL_READ LOAD_CELL=bed_pin

        UPDATE_DELAYED_GCODE ID=BED_PIN_TOUCH_LOOP DURATION=0.005
    {% else %}
        GET_POSITION
    {% endif %}


[delayed_gcode BED_PIN_TOUCH_LOOP]
gcode:
    BED_PIN_TOUCH_AUTO


# [bed_pin_probe]

[gcode_macro TEST_BED_PIN_RESULT]
gcode:
    {% set r = printer["bed_pin_probe"].last_result %}
    RESPOND MSG="RESULT={r}"

# [bed_pin_xy_calibration]

[bed_pin_calibration]

[quadro_bed_mesh]


[quadro_parallel_carriage]
default_speed: 50
min_clearance: 56.25

[axis_slip_test]

# [gcode_macro T0]
# gcode:
#     G91
#     G1 Z1 F1800
#     G90

#     SET_GCODE_OFFSET X=0.000 Y=0.000  MOVE=0

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t3 MODE=PRIMARY
#     G1 X469 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
#     G1 X412.75 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
#     G1 X346 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
#     SET_GCODE_OFFSET Z=0.000 MOVE=1 MOVE_SPEED=10
#     SET_GCODE_OFFSET X=0.000 Y=0.000  MOVE=0
#     # G1 X150 Y150 F6000
#     # G1 Z2  F600



#     ACTIVATE_EXTRUDER EXTRUDER=extruder

#     RESPOND MSG="Tool T0 active | Offset X=0 Y=0 Z=0"

#[gcode_macro T0]
#gcode:
#    {% set active = printer.toolhead.extruder %}
#
#    {% if active == "extruder1" %}
#        one_T0
#    {% elif active == "extruder2" %}
#        two_T0
#    {% elif active == "extruder3" %}
#        three_T0
#    {% elif active == "extruder" %}
#        RESPOND MSG="Already on T0"
#    {% endif %}
    
[gcode_macro zero_T1]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T1", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T1", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T0=-169 T1={physical_x} Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T1
        {% else %}
            QUADRO_PARALLEL_MOVE T0=-169 T1={physical_x} Z={start_z + 3.0} SPEED=350 ARRIVING=T1
        {% endif %}
    {% else %}
        G1 X-169 Z{start_z + 3.0} F21000
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T1

    ACTIVATE_EXTRUDER EXTRUDER=extruder1

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}


[gcode_macro zero_T2]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    ACTIVATE_EXTRUDER EXTRUDER=extruder1
    {% if printer.extruder1.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T2", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T2", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T0=-169 T1=-112.75 T2={physical_x} Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T2
        {% else %}
            QUADRO_PARALLEL_MOVE T0=-169 T1=-112.75 T2={physical_x} Z={start_z + 3.0} SPEED=350 ARRIVING=T2
        {% endif %}
    {% else %}
        QUADRO_PARALLEL_MOVE T0=-169 T1=-112.75 Z={start_z + 3.0} SPEED=350
    {% endif %}

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    # G1 X-112.75 F21000

    {% if printer.extruder1.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder1
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T2

    ACTIVATE_EXTRUDER EXTRUDER=extruder2

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}



[gcode_macro zero_T3]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    ACTIVATE_EXTRUDER EXTRUDER=extruder1
    {% if printer.extruder1.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    ACTIVATE_EXTRUDER EXTRUDER=extruder2
    {% if printer.extruder2.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T3", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T3", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T0=-169 T1=-112.75 T2=-56.50 T3={physical_x + 10.0} Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T3
        {% else %}
            QUADRO_PARALLEL_MOVE T0=-169 T1=-112.75 T2=-56.50 T3={physical_x + 10.0} Z={start_z + 3.0} SPEED=350 ARRIVING=T3
        {% endif %}
    {% else %}
        QUADRO_PARALLEL_MOVE T0=-169 T1=-112.75 T2=-56.50 Z={start_z + 3.0} SPEED=350
    {% endif %}
    # QUADRO_PARALLEL_MOVE T0=-169 T1=-107.75 T2=-46.50 Z={start_z + 3.0} SPEED=350

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    # G1 X-112.75 F21000

    {% if printer.extruder1.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder1
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    # G1 X-56.50 F21000

    {% if printer.extruder2.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder2
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t3 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T3

    ACTIVATE_EXTRUDER EXTRUDER=extruder3

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}

# [gcode_macro T1]
# gcode:
#     G91
#     G1 Z1 F1800
#     G90

#     SET_GCODE_OFFSET X=0.000 Y=0.000  MOVE=0

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
#     G1 X-169 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t3 MODE=PRIMARY
#     G1 X469 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
#     G1 X412.75 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
#     SET_GCODE_OFFSET Z=0.460 MOVE=1 MOVE_SPEED=10
#     SET_GCODE_OFFSET X=-0.590 Y=-0.810  MOVE=0
 
#     ACTIVATE_EXTRUDER EXTRUDER=extruder1

#     RESPOND MSG="Tool T1 active | Offset X=-0.210 Y=-0.680 Z=0.480"



#[gcode_macro T1]
#gcode:
#    {% set active = printer.toolhead.extruder %}
#
#    {% if active == "extruder" %}
#        zero_T1
#    {% elif active == "extruder2" %}
#        two_T1
#    {% elif active == "extruder3" %}
#        three_T1
#    {% elif active == "extruder1" %}
#        RESPOND MSG="Already on T1"
#    {% endif %}

[gcode_macro one_T0]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T0", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T0", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T0={physical_x} T1=356.50 Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T0
        {% else %}
            QUADRO_PARALLEL_MOVE T0={physical_x} T1=356.50 Z={start_z + 3.0} SPEED=350 ARRIVING=T0
        {% endif %}
    {% else %}
        G1 X356.50 Z{start_z + 3.0} F21000
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T0

    ACTIVATE_EXTRUDER EXTRUDER=extruder

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}

[gcode_macro one_T2]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T2", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T2", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T1=-112.75 T2={physical_x} Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T2
        {% else %}
            QUADRO_PARALLEL_MOVE T1=-112.75 T2={physical_x} Z={start_z + 3.0} SPEED=350 ARRIVING=T2
        {% endif %}
    {% else %}
        G1 X-112.75 Z{start_z + 3.0} F21000
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T2

    ACTIVATE_EXTRUDER EXTRUDER=extruder2

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}

[gcode_macro one_T3]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    ACTIVATE_EXTRUDER EXTRUDER=extruder2
    {% if printer.extruder2.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T3", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T3", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T1=-112.75 T2=-56.50 T3={physical_x + 10.0} Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T3
        {% else %}
            QUADRO_PARALLEL_MOVE T1=-112.75 T2=-56.50 T3={physical_x + 10.0} Z={start_z + 3.0} SPEED=350 ARRIVING=T3
        {% endif %}
    {% else %}
        QUADRO_PARALLEL_MOVE T1=-112.75 T2=-56.50 Z={start_z + 3.0} SPEED=350
    {% endif %}

    # QUADRO_PARALLEL_MOVE T1=-107.75 T2=-46.50 Z={start_z + 3.0} SPEED=350

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    # G1 X-112.75 F21000

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    # G1 X-56.50 F21000

    {% if printer.extruder2.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder2
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t3 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T3

    ACTIVATE_EXTRUDER EXTRUDER=extruder3

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}


# [gcode_macro T2]
# gcode:
#     G91
#     G1 Z1 F1800
#     G90
#     SET_GCODE_OFFSET X=0.000 Y=0.000  MOVE=0

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
#     G1 X-169 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
#     G1 X-112.75 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t3 MODE=PRIMARY
#     G1 X469 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
#     SET_GCODE_OFFSET  Z=0.040 MOVE=1 MOVE_SPEED=10
#     SET_GCODE_OFFSET X=-2.260 Y=-0.360  MOVE=0

#     ACTIVATE_EXTRUDER EXTRUDER=extruder2

#     RESPOND MSG="Tool T2 active | Offset X=-2.140 Y=-0.230 Z=0.040"

#[gcode_macro T2]
#gcode:
#    {% set active = printer.toolhead.extruder %}
#
#    {% if active == "extruder" %}
#        zero_T2
#    {% elif active == "extruder1" %}
#        one_T2
#    {% elif active == "extruder3" %}
#        three_T2
#    {% elif active == "extruder2" %}
#        RESPOND MSG="Already on T2"
#    {% endif %}


[gcode_macro two_T0]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    ACTIVATE_EXTRUDER EXTRUDER=extruder1
    {% if printer.extruder1.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T0", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T0", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T0={physical_x - 10.0} T1=356.50 T2=412.75 Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T0
        {% else %}
            QUADRO_PARALLEL_MOVE T0={physical_x - 10.0} T1=356.50 T2=412.75 Z={start_z + 3.0} SPEED=350 ARRIVING=T0
        {% endif %}
    {% else %}
        QUADRO_PARALLEL_MOVE T1=356.50 T2=412.75 Z={start_z + 3.0} SPEED=350
    {% endif %}

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    # G1 X412.75 F21000

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    # G1 X356.50 F21000

    {% if printer.extruder1.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder1
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T0

    ACTIVATE_EXTRUDER EXTRUDER=extruder

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}

[gcode_macro two_T1]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T1", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T1", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T1={physical_x} T2=412.75 Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T1
        {% else %}
            QUADRO_PARALLEL_MOVE T1={physical_x} T2=412.75 Z={start_z + 3.0} SPEED=350 ARRIVING=T1
        {% endif %}
    {% else %}
        G1 X412.75 Z{start_z + 3.0} F21000
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T1

    ACTIVATE_EXTRUDER EXTRUDER=extruder1

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}


[gcode_macro two_T3]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T3", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T3", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T2=-56.50 T3={physical_x} Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T3
        {% else %}
            QUADRO_PARALLEL_MOVE T2=-56.50 T3={physical_x} Z={start_z + 3.0} SPEED=350 ARRIVING=T3
        {% endif %}
    {% else %}
        G1 X-56.50 Z{start_z + 3.0} F21000
    {% endif %}

    # G1 X-56.50 Z{start_z + 3.0} F21000

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t3 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T3

    ACTIVATE_EXTRUDER EXTRUDER=extruder3

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}


# [gcode_macro T3]
# gcode:
#     G91
#     G1 Z1 F1800
#     G90
#     SET_GCODE_OFFSET X=0.000 Y=0.000  MOVE=0

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
#     G1 X-169 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
#     G1 X-112.75 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
#     G1 X-56.50 F18000

#     SET_DUAL_CARRIAGE CARRIAGE=carriage_t3 MODE=PRIMARY
#     SET_GCODE_OFFSET Z=0.210 MOVE=1 MOVE_SPEED=10
#     SET_GCODE_OFFSET X=-0.130 Y=-1.000  MOVE=0

#     ACTIVATE_EXTRUDER EXTRUDER=extruder3

#     RESPOND MSG="Tool T3 active | Offset X=0.080 Y=-0.890 Z=0.240"


#[gcode_macro T3]
#gcode:
#    {% set active = printer.toolhead.extruder %}
#
#    {% if active == "extruder" %}
#        zero_T3
#    {% elif active == "extruder1" %}
#        one_T3
#    {% elif active == "extruder2" %}
#        two_T3
#    {% elif active == "extruder3" %}
#        RESPOND MSG="Already on T3"
#    {% endif %}


[gcode_macro three_T0]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    ACTIVATE_EXTRUDER EXTRUDER=extruder2
    {% if printer.extruder2.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    ACTIVATE_EXTRUDER EXTRUDER=extruder1
    {% if printer.extruder1.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T0", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T0", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T0={physical_x - 10.0} T1=356.50 T2=412.75 T3=469 Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T0
        {% else %}
            QUADRO_PARALLEL_MOVE T0={physical_x - 10.0} T1=356.50 T2=412.75 T3=469 Z={start_z + 3.0} SPEED=350 ARRIVING=T0
        {% endif %}
    {% else %}
        QUADRO_PARALLEL_MOVE T1=356.50 T2=412.75 T3=469 Z={start_z + 3.0} SPEED=350
    {% endif %}

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    # G1 X412.75 F21000

    {% if printer.extruder2.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder2
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    # G1 X356.50 F21000

    {% if printer.extruder1.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder1
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t0 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T0

    ACTIVATE_EXTRUDER EXTRUDER=extruder

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}


[gcode_macro three_T1]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    ACTIVATE_EXTRUDER EXTRUDER=extruder2
    {% if printer.extruder2.temperature >= 190 %}
        G92 E0
        G1 E-0.8 F6000
        G92 E0
    {% endif %}

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T1", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T1", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T1={physical_x} T2=412.75 T3=469 Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T1
        {% else %}
            QUADRO_PARALLEL_MOVE T1={physical_x} T2=412.75 T3=469 Z={start_z + 3.0} SPEED=350 ARRIVING=T1
        {% endif %}
    {% else %}
        QUADRO_PARALLEL_MOVE T2=412.75 T3=469 Z={start_z + 3.0} SPEED=350
    {% endif %}

    # SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    # G1 X412.75 F21000

    {% if printer.extruder2.temperature >= 190 %}
        ACTIVATE_EXTRUDER EXTRUDER=extruder2
        G92 E0
        G1 E0.8 F6000
        G92 E0
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t1 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T1

    ACTIVATE_EXTRUDER EXTRUDER=extruder1

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}

[gcode_macro three_T2]
gcode:
    {% set previous_accel = printer.toolhead.max_accel|float %}
    SET_VELOCITY_LIMIT ACCEL=7000
    {% set start_z = printer.toolhead.position.z|float %}

    G91
    G1 Z0.4 F1800
    G90

    SET_GCODE_OFFSET X=0.000 Y=0.000 MOVE=0

    {% if params.X is defined %}
        {% set slicer_x = params.X|float %}
        {% set x_offset = printer["bed_pin_calibration"].offsets.get("T2", {}).get("x", 0.0)|float %}
        {% set physical_x = slicer_x + x_offset %}

        {% if params.Y is defined %}
            {% set slicer_y = params.Y|float %}
            {% set y_offset = printer["bed_pin_calibration"].offsets.get("T2", {}).get("y", 0.0)|float %}
            {% set physical_y = slicer_y + y_offset %}
        {% endif %}

        {% if params.Y is defined %}
            QUADRO_PARALLEL_MOVE T2={physical_x} T3=469 Y={physical_y} Z={start_z + 3.0} SPEED=350 ARRIVING=T2
        {% else %}
            QUADRO_PARALLEL_MOVE T2={physical_x} T3=469 Z={start_z + 3.0} SPEED=350 ARRIVING=T2
        {% endif %}
    {% else %}
        G1 X469 Z{start_z + 3.0} F21000
    {% endif %}

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t2 MODE=PRIMARY
    BED_PIN_APPLY_OFFSET TOOL=T2

    ACTIVATE_EXTRUDER EXTRUDER=extruder2

    _SYNC_ACTIVE_TOOL_FAN S={printer["gcode_macro M106"].last_s}
    SET_VELOCITY_LIMIT ACCEL={previous_accel}

[gcode_macro M106]
variable_last_s: 0
gcode:
    {% set S = params.S|default(255)|int %}
    SET_GCODE_VARIABLE MACRO=M106 VARIABLE=last_s VALUE={S}
    _SYNC_ACTIVE_TOOL_FAN S={S}

[gcode_macro M107]
gcode:
    SET_GCODE_VARIABLE MACRO=M106 VARIABLE=last_s VALUE=0
    SET_FAN_SPEED FAN=fan_t0 SPEED=0
    SET_FAN_SPEED FAN=fan_t1 SPEED=0
    SET_FAN_SPEED FAN=fan_t2 SPEED=0
    SET_FAN_SPEED FAN=fan_t3 SPEED=0

[gcode_macro _SYNC_ACTIVE_TOOL_FAN]
gcode:
    {% set S = params.S|default(0)|int %}
    {% set speed = S / 255.0 %}
    {% set active = printer.toolhead.extruder %}

    SET_FAN_SPEED FAN=fan_t0 SPEED=0
    SET_FAN_SPEED FAN=fan_t1 SPEED=0
    SET_FAN_SPEED FAN=fan_t2 SPEED=0
    SET_FAN_SPEED FAN=fan_t3 SPEED=0

    {% if active == "extruder" %}
        SET_FAN_SPEED FAN=fan_t0 SPEED={speed}
    {% elif active == "extruder1" %}
        SET_FAN_SPEED FAN=fan_t1 SPEED={speed}
    {% elif active == "extruder2" %}
        SET_FAN_SPEED FAN=fan_t2 SPEED={speed}
    {% elif active == "extruder3" %}
        SET_FAN_SPEED FAN=fan_t3 SPEED={speed}
    {% endif %}



[gcode_macro QUADRO_BED_MESH_CALIBRATE]
gcode:
    G90

    SET_GCODE_OFFSET X=0 Y=0 Z=0 MOVE=0

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t3
    G1 X469 F9000

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t2
    G1 X412.75 F9000

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t1
    G1 X356.50 F9000

    SET_DUAL_CARRIAGE CARRIAGE=carriage_t0
    SET_GCODE_OFFSET X=0 Y=0 Z=0 MOVE=0

    G1 X150 Y150 F6000
    G1 Z5 F300
    BED_MESH_CALIBRATE


[virtual_sdcard]
path: ~/printer_data/gcodes



[gcode_macro M109]
rename_existing: M109.1
gcode:
    {% set S = params.S|default(params.R|default(0))|float %}
    {% set T = params.T|default(0)|int %}
    {% set tol = 3.0 %}

    {% if T == 0 %}
        M104 T0 S{S}
        {% if S > 0 %}
            TEMPERATURE_WAIT SENSOR=extruder MINIMUM={S - tol} MAXIMUM={S + tol}
        {% endif %}
    {% elif T == 1 %}
        M104 T1 S{S}
        {% if S > 0 %}
            TEMPERATURE_WAIT SENSOR=extruder1 MINIMUM={S - tol} MAXIMUM={S + tol}
        {% endif %}
    {% elif T == 2 %}
        M104 T2 S{S}
        {% if S > 0 %}
            TEMPERATURE_WAIT SENSOR=extruder2 MINIMUM={S - tol} MAXIMUM={S + tol}
        {% endif %}
    {% elif T == 3 %}
        M104 T3 S{S}
        {% if S > 0 %}
            TEMPERATURE_WAIT SENSOR=extruder3 MINIMUM={S - tol} MAXIMUM={S + tol}
        {% endif %}
    {% endif %}

[gcode_macro M190]
rename_existing: M190.1
gcode:
    {% set S = params.S|default(params.R|default(0))|float %}
    {% set tol = 3.0 %}
    M140 S{S}
    TEMPERATURE_WAIT SENSOR=heater_bed MINIMUM={S - tol} MAXIMUM={S + tol}


[gcode_arcs]
resolution: 0.1


#[gcode_macro CLEAN_NOZZLE_PURGE]
#gcode:
#    {% set purge_temp = params.TEMP|default(240)|int %}
#    {% set purge_amount = params.AMOUNT|default(4)|float %}
#    {% set x = params.X|default(269)|float %}
#    {% set y = params.Y|default(300)|float %}
#    {% set brush_x = params.BRUSH_X|default(274)|float %}
#    {% set brush_y = params.BRUSH_Y|default(302)|float %}
#    {% set dab_distance = params.DAB_DISTANCE|default(8)|float %}
#    {% set dab_reps = params.DAB_REPS|default(4)|int %}
#    {% set safe_z = params.SAFE_Z|default(1.0)|float %}
#     {% set contact_z = printer.probe.last_z_result %}
#    SAVE_GCODE_STATE NAME=purge_state
#    M109 S{purge_temp}
#    G90
#    G1 X{x} Y{y} F8000
#    G1 Z2 F600
#    M83
    #G1 E{purge_amount} F200      ; asıl temizleyici purge
#    G1 E-2 F1800                 ; retract - akmayı durdur
#    G92 E0
#    G1 Z2 F600
#    G1 X{brush_x} Y{brush_y} F10000
  
#    G1 Z{contact_z - 1} F600   ; duruşsuz, tek hareketle in
#    {% for i in range(dab_reps) %}
#        G1 X{brush_x + dab_distance} F12000
#        G1 X{brush_x} F12000
#    {% endfor %}
#    G1 E1 F1800    ; geri çekerken hafif ileri itip nozzle temiz uçla ayrılsın
#    G1 Z{safe_z} F600
#    G1 Y296 F8000
#    G1 X128 F8000
#    RESTORE_GCODE_STATE NAME=purge_state



# [gcode_macro CLEAN_NOZZLE_BACK]
# gcode:
#     {% set clean_temp = params.TEMP|default(200)|int %}
#     {% set reps = [params.REPS|default(8)|int, 1]|max %}      ; zigzag sayısı
#     {% set circles = [params.CIRCLES|default(3)|int, 1]|max %} ; X boyunca daire noktası sayısı
#     {% set safe_z = params.SAFE_Z|default(5.0)|float %}
#     {% set depth = params.DEPTH|default(1.5)|float %}         ; fırçaya dalma derinliği
#     {% set x0 = params.BRUSH_X0|default(277)|float %}         ; fırça X başlangıcı
#     {% set x1 = params.BRUSH_X1|default(295)|float %}         ; fırça X sonu
#     {% set y0 = params.BRUSH_Y0|default(301)|float %}         ; fırça önü
#     {% set y1 = params.BRUSH_Y1|default(304)|float %}         ; fırça arkası
#     {% set contact_z = printer.probe.last_z_result %}
#     {% set yc = (y0 + y1) / 2 %}
#     {% set r = (y1 - y0) / 2 %}
#     {% set y_step = (y1 - y0) / (reps - 0.5) %}
#     {% set c_step = (x1 - x0 - 2 * r) / ([circles - 1, 1]|max) %}
#     SAVE_GCODE_STATE NAME=clean_nozzle_back_state
#     G90
#     G1 X152 F8000
#     G1 Y308 F8000
#     G1 Z{contact_z - 0.1} F300
#     M109 S{clean_temp}
#     G92 E0
#     G1 Z{safe_z} F300
#     G1 X265 Y296 F10000
#     G1 X265 Y{y0} F10000
#     G1 Z{contact_z - depth} F300
#     ; 1) zigzag: Y302'den 305'e kayarak
#     {% for i in range(reps) %}
#         G1 X{x1} Y{y0 + y_step * i} F12000
#         G1 X{x0} Y{y0 + y_step * (i + 0.5)} F12000
#     {% endfor %}
#     ; 2) daireler: X boyunca kayarak, her noktada iki yönde
#     {% for i in range(circles) %}
#         {% set sx = x0 + c_step * i %}
#         G1 X{sx} Y{yc} F12000
#         G2 X{sx} Y{yc} I{r} J0 F12000
#         G3 X{sx} Y{yc} I{r} J0 F12000
#     {% endfor %}
#     ; 3) fırçadan yana doğru çık, sonra kalk
#     G1 X295 Y{yc} F12000
#     G1 Z{safe_z} F300
#     G1 Y296 F8000
#     M104 S140
#     SET_FAN_SPEED FAN=fan_t0 SPEED=1
#     G4 P1000
#     G1 X265 Y{y0} F10000
#     G1 Z{contact_z - depth} F300
#     ; 1) zigzag: Y302'den 305'e kayarak
#     {% for i in range(reps) %}
#         G1 X{x1} Y{y0 + y_step * i} F12000
#         G1 X{x0} Y{y0 + y_step * (i + 0.5)} F12000
#     {% endfor %}
#     ; 2) daireler: X boyunca kayarak, her noktada iki yönde
#     {% for i in range(circles) %}
#         {% set sx = x0 + c_step * i %}
#         G1 X{sx} Y{yc} F12000
#         G2 X{sx} Y{yc} I{r} J0 F12000
#         G3 X{sx} Y{yc} I{r} J0 F12000
#     {% endfor %}
#     ; 3) fırçadan yana doğru çık, sonra kalk
#     G1 X295 Y{yc} F12000
#     G1 Z{safe_z} F300
#     G1 Y296 F8000
#     G1 X155 F8000
#     G1 Y308 F8000
#     G1 Z{contact_z - 0.1} F300
#     SET_FAN_SPEED FAN=fan_t0 SPEED=0
#     RESTORE_GCODE_STATE NAME=clean_nozzle_back_state



#new nozzle back


[gcode_macro CLEAN_NOZZLE_BACK]
gcode:
    {% set clean_temp = params.TEMP|default(150)|int %}
    {% set touch_z = params.TOUCH_Z|default(1.466)|float %}
    {% set depth = params.DEPTH|default(1.30)|float %}
    {% set wipe_z = touch_z - depth %}
    {% set safe_z = params.SAFE_Z|default(5.0)|float %}
    {% set speed = params.SPEED|default(80)|float %}
    {% set contact_z = printer.probe.last_z_result %}

    {% set xl = 265.0 %}
    {% set xr = 297.0 %}
    {% set yf = 299.0 %}
    {% set yb = 307.0 %}
    {% set wipe_f = speed * 60 %}

    SAVE_GCODE_STATE NAME=clean_nozzle_back_state
    G90

    # Orijinal isitma yaklasimi
    G1 X152 F8000
    G1 Y308 F8000
    G1 Z{contact_z - 0.1} F300
    M109 S{clean_temp}
    G92 E0

    G1 Z{safe_z} F300
    G1 X265 Y296 F10000

    {% for stage in range(2) %}

        {% if stage == 1 %}
            M104 S{clean_temp}
            SET_FAN_SPEED FAN=fan_t0 SPEED=1
            G4 P1000
        {% endif %}

        # Fircanin sol disinda temizleme yuksekligine in
        G1 X{xl} Y301.50 F10000
        G1 Z{wipe_z} F300

        # Merkez, -0.3 mm ve +0.3 mm kaydirilmis desenler
        {% for shift in [0.0, -0.3, 0.3] %}

            # Sol dis kenardan baslangic sirasina git
            G1 X{xl} F{wipe_f}
            G1 Y{301.50 + shift} F{wipe_f}

            # X boyunca birinci ara
            G1 X{xr} F{wipe_f}

            # Sag dis kenarda ikinci araya gec
            G1 Y{303.10 + shift} F{wipe_f}
            G1 X{xl} F{wipe_f}

            # Sol dis kenarda ucuncu araya gec
            G1 Y{304.50 + shift} F{wipe_f}
            G1 X{xr} F{wipe_f}

            # Sag dis kenardan fircanin arkasina dolan
            G1 Y{yb} F{wipe_f}
            G1 X{292.80 + shift} F{wipe_f}

            # Y boyunca sag ara
            G1 Y{yf} F{wipe_f}

            # On dis kenardan orta araya gec
            G1 X{280.70 + shift} F{wipe_f}
            G1 Y{yb} F{wipe_f}

            # Arka dis kenardan sol araya gec
            G1 X{268.60 + shift} F{wipe_f}
            G1 Y{yf} F{wipe_f}

        {% endfor %}

        # Fircanin disinda yuksel
        G1 Z{safe_z} F300
        G1 Y296 F8000
        G1 X265 F10000

    {% endfor %}

    # Orijinal donus
    G1 X155 F8000
    G1 Y308 F8000
    G1 Z{contact_z - 0.1} F300
    SET_FAN_SPEED FAN=fan_t0 SPEED=0

    RESTORE_GCODE_STATE NAME=clean_nozzle_back_state MOVE=0



[gcode_macro CLEAN_NOZZLE_TOUCH]
gcode:
    {% set clean_temp = params.TEMP|default(150)|int %}
    {% set bed_temp = params.BED_TEMP|default(60)|int %}
    {% set start_x = params.X|default(128)|float %}
    {% set start_y = params.Y|default(308)|float %}
    {% set points = params.POINTS|default(6)|int %}
    {% set step = params.STEP|default(2)|float %}
    {% set safe_z = params.SAFE_Z|default(1)|float %}

    SAVE_GCODE_STATE NAME=clean_nozzle_state

    #M140 S{bed_temp}      ; tabla ısıtmayı başlat (bekleme yok, paralel ısınsın)
    M109 S{clean_temp}    ; nozzle temiz sıcaklığa gelsin
    G92 E0
    #G1 E-1 F500           ; hafif retract
    #M190 S{bed_temp}      ; tabla hedefe ulaşana kadar bekle
    G90
    G1 Z{safe_z} F300

    {% for i in range(points) %}
        G1 X{start_x + i*step} Y{start_y} F10000
        PROBE SAMPLES=1
        G1 Z{safe_z} F300
    {% endfor %}

    RESTORE_GCODE_STATE NAME=clean_nozzle_state



[gcode_macro CLEAN_NOZZLE_SCRAPE]
gcode:
    {% set first_layer_temp = params.FIRST_LAYER_TEMP|default(220)|int %}
    {% set pre_temp = 150 %}
    {% set final_temp = params.FINAL_TEMP|default(140)|int %}
    {% set x = params.X|default(150)|float %}
    {% set y = params.Y|default(308)|float %}
    {% set x_offset = params.X_OFFSET|default(10)|float %}
    {% set spots = params.SPOTS|default(1)|int %}
    {% set push = params.PUSH|default(0.10)|float %}
    {% set safe_z = params.SAFE_Z|default(5)|float %}
    {% set reps = params.REPS|default(9)|int %}
    SAVE_GCODE_STATE NAME=scrape_state
    M109 S{pre_temp}
    G90
    G1 Z{safe_z} F300
    M104 S{final_temp}
    {% for s in range(spots) %}
        {% set spot_x = x - (s * x_offset) %}
        G1 X{spot_x} Y{y} F8000
        PROBE SAMPLES=1
        {% set contact_z = printer.probe.last_z_result %}
        G1 Z{contact_z - push} F300
        {% set ns = namespace(cx = spot_x, cy = y) %}
        {% for i in range(reps) %}
            {% set ns.cx = ns.cx - 2 %}
            G2 I-1 J0 X{ns.cx} Y{ns.cy} F2000
            {% set ns.cx = ns.cx + 1.5 %}
            G2 I0.75 J0 X{ns.cx} Y{ns.cy} F2000
        {% endfor %}
        G1 Z{safe_z} F300
    {% endfor %}
    RESTORE_GCODE_STATE NAME=scrape_state


[gcode_macro _PRINT_HOME]
gcode:
    {% set temp = params.TEMP|default(220)|int %}
    {% set bed_temp = params.BED_TEMP|default(60)|int %}

    M104 S140
    M140 S{bed_temp-5}

    G28
    G90

    CLEAN_NOZZLE_BACK
    CLEAN_NOZZLE_TOUCH
    CLEAN_NOZZLE_SCRAPE FIRST_LAYER_TEMP={temp}

    G90
    G1 Z5 F300
    G1 X150 Y150 F6000
    BED_MESH_CLEAR
    
    # Son Z home kesinlikle 55C tabloda yapılsın
    M190 S{bed_temp-5}

    _HOME_Z

[gcode_macro _CALIBRATION_HOME]
gcode:
      {% set temp = params.TEMP|default(220)|int %}
      M104 S140
      G28
      CLEAN_NOZZLE_BACK
      CLEAN_NOZZLE_TOUCH
      CLEAN_NOZZLE_SCRAPE FIRST_LAYER_TEMP={temp}
      G90
      G1 Z5 F300
      G1 X150 Y150 F6000
      M104 S80
      SET_FAN_SPEED FAN=fan_t0 SPEED=100
      M109 S80
      SET_FAN_SPEED FAN=fan_t0 SPEED=0
      _HOME_Z

[gcode_macro _BED_MESH_HOME]
gcode:
  CLEAN_NOZZLE_TOUCH
  CLEAN_NOZZLE_SCRAPE
  G90
  G1 Z5 F300
  G1 X150 Y150 F6000
  _HOME_Z

  SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='"CALIBRATION_CLEANING_DONE"'
  BED_MESH_CLEAR
  QUADRO_CUSTOM_BED_MESH PROFILE=default
  SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='"CALIBRATION_BED_DONE"'
```

## cp_macro_2.cfg
```
#[gcode_macro LOAD_FILAMENT]
#gcode:
#      M83
#      G1 E100 F300
#	  M118 


[gcode_macro UNLOAD_FILAMENT]
gcode:
      M83
      G1 E-100 F300
	  M118 
      M104 S0
[gcode_macro LOAD_FILAMENT]
gcode:
      M83
      G1 E20 F300
	  M118 
      M104 S0
    
[gcode_macro PARK_FILAMENT]
gcode:
      M83
      G1 E-100 F300


[gcode_macro _CLIENT_VARIABLE]
variable_use_custom_pos   : True #; use custom park coordinates for x,y [True/False]
variable_custom_park_x    : 280.0   ; custom x position; value must be within your defined min and max of X
variable_custom_park_y    : 280.0   ; custom y position; value must be within your defined min and max of Y
gcode:


[gcode_macro _TOOLHEAD_PARK_PAUSE_CANCEL]
description: Helper: park toolhead used in PAUSE and CANCEL_PRINT
variable_extrude: 1.0
gcode:
  ##### set park positon for x and y #####
  # default is your max posion from your printer.cfg

  {% set x_park = printer.toolhead.axis_maximum.x|float - 170.0 %}
  {% set y_park = printer.toolhead.axis_maximum.y|float - 170.0 %}
  {% set z_park_delta = 2.0 %}
  ##### calculate save lift position #####
  {% set max_z = printer.toolhead.axis_maximum.z|float %}
  {% set act_z = printer.toolhead.position.z|float %}
  {% if act_z < (max_z - z_park_delta) %}
    {% set z_safe = z_park_delta %}
  {% else %}
    {% set z_safe = max_z - act_z %}
  {% endif %}
  ##### end of definitions #####
  {% if printer.extruder.can_extrude|lower == 'true' %}
    M83
    #G1 E-{extrude} F2100
    {% if printer.gcode_move.absolute_extrude |lower == 'true' %} M82 {% endif %}
  {% else %}
    {action_respond_info("Extruder not hot enough")}
  {% endif %}
  {% if "xyz" in printer.toolhead.homed_axes %}
    G91
    G1 Z{z_safe} F900
    G90
    G1 X{x_park} Y{y_park} F6000
    {% if printer.gcode_move.absolute_coordinates|lower == 'false' %} G91 {% endif %}
  {% else %}
    {action_respond_info("Printer not homed")}
  {% endif %}



[gcode_macro PARK_TOOLHEAD]
description: Helper: park toolhead used in PAUSE and CANCEL_PRINT
variable_extrude: 1.0
gcode:
    {% set active = printer.toolhead.extruder %}
    {% set y_park = printer.toolhead.axis_maximum.y|float - 170.0 %}
    
    {% if active == "extruder" %}
        {% set x_park = -169 %}
    {% elif active == "extruder1" %}
        {% set x_park = -112.75 %}
    {% elif active == "extruder2" %}
        {% set x_park = 412.75 %}
    {% elif active == "extruder3" %}
        {% set x_park = 469 %}
    {% else %}
        {% set x_park = printer.toolhead.axis_maximum.x|float - 170.0 %}
    {% endif %}
    
    {% set z_park_delta = 2.0 %}
    ##### calculate save lift position #####
    {% set max_z = printer.toolhead.axis_maximum.z|float %}
    {% set act_z = printer.toolhead.position.z|float %}
    {% if act_z < (max_z - z_park_delta) %}
        {% set z_safe = z_park_delta %}
    {% else %}
        {% set z_safe = max_z - act_z %}
    {% endif %}
    ##### end of definitions #####
    {% if printer.extruder.can_extrude|lower == 'true' %}
        M83
        #G1 E-{extrude} F2100
        {% if printer.gcode_move.absolute_extrude |lower == 'true' %} M82 {% endif %}
    {% else %}
        {action_respond_info("Extruder not hot enough")}
    {% endif %}
    {% if "xyz" in printer.toolhead.homed_axes %}
        SAVE_GCODE_STATE NAME=PARK_TOOLHEAD_STATE
        SET_GCODE_OFFSET X=0 Y=0
        G91
        G1 Z{z_safe} F900
        G90
        G1 X{x_park} Y{y_park} F6000
        RESTORE_GCODE_STATE NAME=PARK_TOOLHEAD_STATE MOVE=0
        {% if printer.gcode_move.absolute_coordinates|lower == 'false' %} G91 {% endif %}
    {% else %}
        {action_respond_info("Printer not homed")}
    {% endif %}

[gcode_macro CANCEL_PRINT]
description: Cancel the actual running print
rename_existing: CANCEL_PRINT_BASE
variable_park: True
gcode:
  ## Move head and retract only if not already in the pause state and park set to true

  {% if printer.pause_resume.is_paused|lower == 'false' and park|lower == 'true'%}
    #_TOOLHEAD_PARK_PAUSE_CANCEL
    PARK_TOOLHEAD
  {% endif %}
  SET_TOOL_MAP LOGICAL=0 PHYSICAL=0
  SET_TOOL_MAP LOGICAL=1 PHYSICAL=1
  SET_TOOL_MAP LOGICAL=2 PHYSICAL=2
  SET_TOOL_MAP LOGICAL=3 PHYSICAL=3



  # FILAMENT_CUT
  # G91
  # G1 E-78
  TURN_OFF_HEATERS
  CANCEL_PRINT_BASE

[gcode_macro PAUSE]
description: Pause the actual running print
rename_existing: PAUSE_BASE
gcode:
  PAUSE_BASE
  #_TOOLHEAD_PARK_PAUSE_CANCEL
  PARK_TOOLHEAD

[gcode_macro RESUME]
description: Resume the actual running print
rename_existing: RESUME_BASE
gcode:
  ##### read extrude from  _TOOLHEAD_PARK_PAUSE_CANCEL  macro #####

  {% set extrude = printer['gcode_macro _TOOLHEAD_PARK_PAUSE_CANCEL'].extrude %}
  #### get VELOCITY parameter if specified ####
  {% if 'VELOCITY' in params|upper %}
    {% set get_params = ('VELOCITY=' + params.VELOCITY)  %}
  {%else %}
    {% set get_params = "" %}
  {% endif %}
  ##### end of definitions #####
  {% if printer.extruder.can_extrude|lower == 'true' %}
    M83
    G1 E{extrude} F2100
    {% if printer.gcode_move.absolute_extrude |lower == 'true' %} M82 {% endif %}
  {% else %}
    {action_respond_info("Extruder not hot enough")}
  {% endif %}



  RESUME_BASE {get_params}

[gcode_macro PRINT_STATE]
variable_bed_leveling: 0
variable_flow_calibration: 0
variable_record_timelapse: 0
gcode:
  # That is for the moment only a placeholder, but it can be used to set some variables for the print state.

[gcode_macro END_PRINT]
gcode:
    {% set active = printer.toolhead.extruder %}
    {% set y_stop = printer.toolhead.axis_maximum.y|float - 170.0 %}
    {% set state = printer["gcode_macro PRINT_STATE"] %}

    {% if active == "extruder" %}
        {% set x_stop = -169 %}
    {% elif active == "extruder1" %}
        {% set x_stop = -112.75 %}
    {% elif active == "extruder2" %}
        {% set x_stop = 412.75 %}
    {% elif active == "extruder3" %}
        {% set x_stop = 469 %}
    {% else %}
        {% set x_stop = 280 %}
    {% endif %}

    {% set z_stop = printer.toolhead.axis_maximum.z|int %}
    {% set z_pos = printer.toolhead.position.z|int %}
    {% if z_pos < (z_stop-6) %}
      G91
      G1 Z5 F600
    {% else %}
      G91
      G1 Z1 F600
    {% endif %}
    SAVE_GCODE_STATE NAME=END_PRINT_STATE
    G90
    SET_GCODE_OFFSET X=0 Y=0 MOVE=0
    G1 X{x_stop} Y{y_stop} F10000
    
    RESTORE_GCODE_STATE NAME=END_PRINT_STATE MOVE=0

    TURN_OFF_HEATERS
    SET_TOOL_MAP LOGICAL=0 PHYSICAL=0
    SET_TOOL_MAP LOGICAL=1 PHYSICAL=1
    SET_TOOL_MAP LOGICAL=2 PHYSICAL=2
    SET_TOOL_MAP LOGICAL=3 PHYSICAL=3
    M84
    {% if state.record_timelapse == 1 %}
        TIMELAPSE_RENDER
        _SET_TIMELAPSE_SETUP ENABLE=False
    {% endif %}


[gcode_macro START_PRINT]
gcode:
    # BED_MESH_PROFILE LOAD=default
    {% set BED_TEMP = params.BED_TEMP|default(60)|float %}
    {% set EXTRUDER = params.EXTRUDER|default(0)|int %}
    {% set EXTRUDER_TEMP = params.EXTRUDER_TEMP|default(200)|float %}
    {% set axismax = printer.toolhead.axis_maximum %}
    {% set axismin_x = printer.toolhead.axis_minimum.x %}
    {% set axismin_y = printer.toolhead.axis_minimum.y %}
    {% set EXT0 = params.EXT0|default('false')|lower == 'true' %}
    {% set EXT1 = params.EXT1|default('false')|lower == 'true' %}
    {% set EXT2 = params.EXT2|default('false')|lower == 'true' %}
    {% set EXT3 = params.EXT3|default('false')|lower == 'true' %}
    {% set EXT0_TEMP = params.EXT0_TEMP|default(EXTRUDER_TEMP)|float %}
    {% set EXT1_TEMP = params.EXT1_TEMP|default(EXTRUDER_TEMP)|float %}
    {% set EXT2_TEMP = params.EXT2_TEMP|default(EXTRUDER_TEMP)|float %}
    {% set EXT3_TEMP = params.EXT3_TEMP|default(EXTRUDER_TEMP)|float %}
    {% set state = printer["gcode_macro PRINT_STATE"] %}

    # Home the printer
    #G28
    BED_MESH_PROFILE LOAD=default
    _PRINT_HOME TEMP={EXTRUDER_TEMP} BED_TEMP={BED_TEMP}

    # BED_MESH_CALIBRATE PROFILE="default"
    {% if state.bed_leveling == 1 %}
        BED_MESH_CLEAR
        QUADRO_CUSTOM_BED_MESH PROFILE=default
    {% endif %}
    {% if state.flow_calibration == 1 %}
        #FLOW_CALIBRATION
    {% endif %}
    {% if state.record_timelapse == 1 %}
        _SET_TIMELAPSE_SETUP ENABLE=True PARK_ENABLE=False
    {% else %}
        _SET_TIMELAPSE_SETUP ENABLE=False
    {% endif %}
    #BED_MESH_PROFILE LOAD=default
    BED_MESH_PROFILE LOAD=default
    #SET_INPUT_SHAPER SHAPER_TYPE_X=mzv SHAPER_FREQ_X=51.2 SHAPER_TYPE_Y=mzv SHAPER_FREQ_Y=31.0
    # Heat bed for probing
    M140 S{BED_TEMP}
    # Use absolute coordinates
    G90

    G1 Z10 F450
    G1 X-169 F12000

    T{EXTRUDER}
    PRINT_STATE_START EXTRUDER_INDEX={EXTRUDER}
    # M109 S{EXTRUDER_TEMP}
    {% if EXT0 %}
      M104 T0 S{EXT0_TEMP}
    {% endif %}
    {% if EXT1 %}
      M104 T1 S{EXT1_TEMP}
    {% endif %}
    {% if EXT2 %}
      M104 T2 S{EXT2_TEMP}
    {% endif %}
    {% if EXT3 %}
      M104 T3 S{EXT3_TEMP}
    {% endif %}
    M109 T{EXTRUDER} S{EXTRUDER_TEMP}
    M190 S{BED_TEMP}
    #_PURGE_NEW_FILAMENTS USED0={1 if EXT0 else 0} USED1={1 if EXT1 else 0} USED2={1 if EXT2 else 0} USED3={1 if EXT3 else 0}

    # Purge line for the active toolhead before printing
    {% set old_absolute_extrude = printer.gcode_move.absolute_extrude %}
    M83
    G92 E0
    G1 X100 Y1 Z0.2 F6000
    G1 X200 Y1 Z0.2 E15 F900
    G92 E0
    {% if old_absolute_extrude %} M82 {% endif %}

    {% if PURGE_LINE == 'true' %}
      {% if axismax.x > 200 %}
        G92 E0
        G1 X20 Y152 Z0.4 F900
        G92 E0
        G1 Y77 E20 F900
        G92 E0
        G1 Y10 E20 F900
        G92 E0
        G1 X100 E30 F900
        G92 E0
        G1 X200 E30 F900
        G92 E0
        G1 Y12 F900
        G92 E0
        G1 X100 E30 F900
        G92 E0
        G1 X22 E30 F900
        G92 E0
        G1 Y77 E20 F900
        G92 E0
        G1 Y152 E20 F900
        G92 E0 ;Reset Extruder
      {% else %}

      {% endif %}
    {% else %}
    {% endif %}
    G92 E0 ;Reset Extruder
    
[exclude_object]

# [gcode_macro START_PRINT]
# gcode:
#     # BED_MESH_PROFILE LOAD=default
#     {% set BED_TEMP = params.BED_TEMP|default(60)|float %}
#     {% set EXTRUDER = params.EXTRUDER|default(0)|int %}
#     {% set EXTRUDER_TEMP = params.EXTRUDER_TEMP|default(200)|float %}
#     {% set axismax = printer.toolhead.axis_maximum %}
#     {% set axismin_x = printer.toolhead.axis_minimum.x %}
#     {% set axismin_y = printer.toolhead.axis_minimum.y %}
#     {% set EXT0 = params.EXT0|default('false')|lower == 'true' %}
#     {% set EXT1 = params.EXT1|default('false')|lower == 'true' %}
#     {% set EXT2 = params.EXT2|default('false')|lower == 'true' %}
#     {% set EXT3 = params.EXT3|default('false')|lower == 'true' %}
#     {% set state = printer["gcode_macro PRINT_STATE"] %}

#     # Home the printer
#     #G28  
#     _PRINT_HOME TEMP={EXTRUDER_TEMP}

#     # BED_MESH_CALIBRATE PROFILE="default"
#     {% if state.bed_leveling == 1 %}
#         BED_MESH_CALIBRATE PROFILE="default"
#     {% endif %}
#     {% if state.flow_calibration == 1 %}
#         #FLOW_CALIBRATION
#     {% endif %}
#     {% if state.record_timelapse == 1 %}
#         #RECORD_TIMELAPSE
#     {% endif %}
#     BED_MESH_PROFILE LOAD=default
#     SET_INPUT_SHAPER SHAPER_TYPE_X=mzv SHAPER_FREQ_X=60.0 SHAPER_TYPE_Y=mzv SHAPER_FREQ_Y=46.4
#     # Heat bed for probing
#     M140 S{BED_TEMP}
#     # Use absolute coordinates
#     G90

#     G1 Z10 F450
#     G1 X-157.25 F18000

#     T{EXTRUDER}
#     # M109 S{EXTRUDER_TEMP}
#     {% if EXT0 %}
#       M104 T0 S{EXTRUDER_TEMP}
#     {% endif %}
#     {% if EXT1 %}
#       M104 T1 S{EXTRUDER_TEMP}
#     {% endif %}
#     {% if EXT2 %}
#       M104 T2 S{EXTRUDER_TEMP}
#     {% endif %}
#     {% if EXT3 %}
#       M104 T3 S{EXTRUDER_TEMP}
#     {% endif %}
#     M190 S{BED_TEMP}
#     M109 T{EXTRUDER} S{EXTRUDER_TEMP}
#     _PURGE_NEW_FILAMENTS USED0={1 if EXT0 else 0} USED1={1 if EXT1 else 0} USED2={1 if EXT2 else 0} USED3={1 if EXT3 else 0}

#     {% if PURGE_LINE == 'true' %}
#       {% if axismax.x > 200 %}
#         G92 E0 
#         G1 X20 Y152 Z0.4 F900 
#         G92 E0
#         G1 Y77 E20 F900 
#         G92 E0
#         G1 Y10 E20 F900 
#         G92 E0
#         G1 X100 E30 F900 
#         G92 E0
#         G1 X200 E30 F900 
#         G92 E0
#         G1 Y12 F900 
#         G92 E0
#         G1 X100 E30 F900
#         G92 E0
#         G1 X22 E30 F900 
#         G92 E0
#         G1 Y77 E20 F900
#         G92 E0
#         G1 Y152 E20 F900
#         G92 E0 ;Reset Extruder
#       {% else %}

#       {% endif %}
#     {% else %}
#     {% endif %}
#     G92 E0 ;Reset Extruder
# [exclude_object] 



[gcode_macro SNAPSHOT_TIMELAPSE]
gcode:
    {% set active = printer.toolhead.extruder %}
    {% set x_min = printer.toolhead.axis_minimum.x|float %}
    {% set x_max = printer.toolhead.axis_maximum.x|float %}

    {% if active == "extruder" %}
        {% set x_park = -169 %}
    {% elif active == "extruder1" %}
        {% set x_park = -112.75 %}
    {% elif active == "extruder2" %}
        {% set x_park = 412.75 %}
    {% elif active == "extruder3" %}
        {% set x_park = 469 %}
    {% else %}
        {% set x_park = x_max - 170.0 %}
    {% endif %}

    SAVE_GCODE_STATE NAME=SNAPSHOT_TIMELAPSE_STATE
    G90
    SET_GCODE_OFFSET X=0 Y=0            ; aktif tool'un XY offset'ini geçici sıfırla, x_park gerçek fiziksel konum olsun

    ; --- Nozzle touch/temizlik + timelapse konumlama ---
    G1 X{x_park} F12000
    G1 Y304 F12000
    G4 P100
    G1 Y306.30 F1500
    G4 P1500
    G1 Y304 F1500
    G1 F12000

    RESTORE_GCODE_STATE NAME=SNAPSHOT_TIMELAPSE_STATE

[gcode_macro TIMELAPSE_PARK]
gcode:
    {% set active = printer.toolhead.extruder %}
    {% set x_min = printer.toolhead.axis_minimum.x|float %}
    {% set x_max = printer.toolhead.axis_maximum.x|float %}

    {% if active == "extruder" %}
        {% set x_park = -169 %}
    {% elif active == "extruder1" %}
        {% set x_park = -112.75 %}
    {% elif active == "extruder2" %}
        {% set x_park = 412.75 %}
    {% elif active == "extruder3" %}
        {% set x_park = 469 %}
    {% else %}
        {% set x_park = x_max - 170.0 %}
    {% endif %}

    SAVE_GCODE_STATE NAME=TIMELAPSE_PARK_STATE
    G90
    SET_GCODE_OFFSET X=0 Y=0            ; aktif tool'un XY offset'ini geçici sıfırla, x_park gerçek fiziksel konum olsun

    ; --- Nozzle touch/temizlik + timelapse konumlama ---
    G1 X{x_park} F12000
    G1 Y300 F12000
    G4 P1000
    TIMELAPSE_TAKE_FRAME
    G4 P500
    

    RESTORE_GCODE_STATE NAME=TIMELAPSE_PARK_STATE

[gcode_macro TIMELAPSE_TAKE_PHOTO]
gcode:
    {% set state = printer["gcode_macro PRINT_STATE"] %}
    {% if state.record_timelapse == 1 %}
        TIMELAPSE_PARK
    {% endif %}


[gcode_macro FILAMENT_LOAD]
gcode:
    {% set length = params.LENGTH|default(50)|float %}
    {% set speed = params.SPEED|default(300)|float %}
    G91
    G92 E0
    G1 E{length} F{speed}
    G92 E0
    G90

[gcode_macro FILAMENT_LOAD_FINISH]
gcode:
    {% set length = params.LENGTH|default(150)|float %}
    {% set speed = params.SPEED|default(300)|float %}
    G91
    G92 E0
    G1 E100 F{speed}
    G92 E0
    G1 E{length - 100} F{speed}
    G92 E0
    G90

[gcode_macro FILAMENT_UNLOAD]
gcode:
    {% set length = params.LENGTH|default(200)|float %}
    {% set speed = params.SPEED|default(600)|float %}
    G91
    G92 E0
    G1 E10 F300
    G92 E0
    G1 E-{length / 2} F{speed}
    G92 E0
    G1 E-{length / 2} F{speed}
    G92 E0
    G90

[gcode_macro FILAMENT_UNLOAD_RETRY]
gcode:
    FILAMENT_UNLOAD
```

## calibration_wizard.cfg
```
# Drop-in for the printer (replace calibration_wizard.cfg / include this file).
# Screen must send one tool at a time. Do not run T0-T3 in a single script:
# Jinja cannot wait for the user after INCONSISTENT.
# Pair with the updated bed_pin_calibration.py.
#
# Screen:
#   BED_PIN_CALIBRATE_TOOL TOOL=T0 RESET=0 FIRST=0|1
#   retry: BED_PIN_CALIBRATE_TOOL TOOL=Tn RETRY=1 RESET={1 if T0 else 0}
#   after T3_DONE: CALIBRATE_LEVELING_FINISH
# ======================================================================
# FULL CALIBRATION WIZARD MACROS
# ======================================================================


[gcode_macro CALIBRATION_STATUS]
variable_stage: "IDLE"
variable_delta_x: 0.0
variable_delta_y: 0.0
variable_delta_z: 0.0
variable_inconsistent_tool: ""
gcode:
    {action_respond_info("Guncel Durum: %s tool=%s dx=%.5f dy=%.5f dz=%.5f" % (stage, inconsistent_tool, delta_x, delta_y, delta_z))}

# --- STAGE 1: AXIS HOMING ---
[gcode_macro CALIBRATE_HOMING]
description: Arayuzden tetiklenen guvenli homing
gcode:
    _CALIBRATION_HOME
    M400

    M140 S0

    M400
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='"CALIBRATION_HOMING_DONE"'

# Not: STAGE 2 (Heating) makrosu yoktur cunku Python sicakligi canli olarak
# kendisi okuyup yonetiyor.

# --- STAGE 3: NOZZLE CLEANING ---

# --- STAGE 4: TOOLHEAD LEVELING ---
# One tool. Plugin sets CALIBRATION_LEVELING_Tn_DONE or _INCONSISTENT.
# Do not SET Tn_DONE here: on fail the plugin must keep INCONSISTENT.
[gcode_macro CALIBRATE_LEVELING_TOOL]
description: Single-tool bed pin measure with consistency check
gcode:
    {% set tool = params.TOOL|default("T0")|upper %}
    {% set first = params.FIRST|default(0)|int %}
    {% set retry = params.RETRY|default(0)|int %}
    {% set reset = params.RESET|default(0)|int %}
    G90
    BED_PIN_CALIBRATE_TOOL TOOL={tool} RESET={reset} FIRST={first} RETRY={retry}
    M400

[gcode_macro CALIBRATE_LEVELING_FINISH]
description: Save offsets after T3 pass and mark leveling done
gcode:
    BED_PIN_SAVE_OFFSETS
    M400
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='"CALIBRATION_LEVELING_DONE"'
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=delta_x VALUE=0.0
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=delta_y VALUE=0.0
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=delta_z VALUE=0.0
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=inconsistent_tool VALUE='""'

# Console / old name. If TOOL= is given, run that tool. Without TOOL, do not
# walk T0-T3: a fail cannot pause a Jinja script.
[gcode_macro CALIBRATE_LEVELING]
description: Single-tool leveling wrapper. UI must pass TOOL=.
gcode:
    {% set tool = params.TOOL|default("")|upper %}
    {% if tool == "" %}
        {action_respond_info("CALIBRATE_LEVELING requires TOOL=T0..T3. After T3_DONE call CALIBRATE_LEVELING_FINISH.")}
    {% else %}
        CALIBRATE_LEVELING_TOOL TOOL={tool} FIRST={params.FIRST|default(0)|int} RETRY={params.RETRY|default(0)|int} RESET={params.RESET|default(0)|int}
    {% endif %}

# Removed as a 4-tool loop. Welcome uses FIRST=1 on each TOOL call instead.
[gcode_macro CALIBRATE_FIRST_LEVELING]
description: Use CALIBRATE_LEVELING_TOOL TOOL=Tn FIRST=1
gcode:
    {% set tool = params.TOOL|default("")|upper %}
    {% if tool == "" %}
        {action_respond_info("CALIBRATE_FIRST_LEVELING requires TOOL=T0..T3 FIRST=1. After T3_DONE call CALIBRATE_LEVELING_FINISH.")}
    {% else %}
        CALIBRATE_LEVELING_TOOL TOOL={tool} FIRST={params.FIRST|default(1)|int} RETRY={params.RETRY|default(0)|int} RESET={params.RESET|default(0)|int}
    {% endif %}


# --- STAGE 5: BUILD PLATE CALIBRATION (BED MESH) ---
[gcode_macro CALIBRATE_BED_MESH]
description: Yatak kalibrasyonu (Mesh) alma
gcode:
    T0
    M190 S55
    BED_MESH_CLEAR
    QUADRO_CUSTOM_BED_MESH PROFILE=default REPEATS=1 

    QUADRO_CUSTOM_BED_MESH PROFILE=default REPEATS=2

    M400
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='"CALIBRATION_BED_DONE"'


# --- STAGE 6: INPUT SHAPING ---
[gcode_macro CALIBRATE_INPUT_SHAPING]
description: ADXL ile titresim kalibrasyonu
gcode:
    T0
    #SHAPER_CALIBRATE
    QUADRO_SHAPER_CALIBRATE

    M400
    SET_GCODE_VARIABLE MACRO=CALIBRATION_STATUS VARIABLE=stage VALUE='"CALIBRATION_SHAPING_DONE"'

# ======================================================================
```

## purge_filament_macros.cfg
```
# Filament "new" flag + print-start purge
# Copy into the printer Klipper config and call _PURGE_NEW_FILAMENTS from START_PRINT
# after heaters/tools are ready and before the first print layer.
#
# Clients (QuadroScreen + slicer fork) must use only:
#   MARK_FILAMENT_NEW TOOL=0|1|2|3
#   CLEAR_FILAMENT_NEW TOOL=0|1|2|3
# Do not use SAVE_VARIABLE / gcode_shell for this flag.

[gcode_macro _FILAMENT_STATE]
variable_new_t0: 0
variable_new_t1: 0
variable_new_t2: 0
variable_new_t3: 0
gcode:

[gcode_macro MARK_FILAMENT_NEW]
description: Mark tool as newly loaded (purge once on next START_PRINT)
gcode:
    {% set t = params.TOOL|default(0)|int %}
    {% if t < 0 or t > 3 %}
        {action_raise_error("MARK_FILAMENT_NEW: TOOL must be 0..3")}
    {% endif %}
    {% if t == 0 %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t0 VALUE=1
    {% elif t == 1 %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t1 VALUE=1
    {% elif t == 2 %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t2 VALUE=1
    {% else %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t3 VALUE=1
    {% endif %}

[gcode_macro CLEAR_FILAMENT_NEW]
description: Clear new-filament flag for tool
gcode:
    {% set t = params.TOOL|default(0)|int %}
    {% if t < 0 or t > 3 %}
        {action_raise_error("CLEAR_FILAMENT_NEW: TOOL must be 0..3")}
    {% endif %}
    {% if t == 0 %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t0 VALUE=0
    {% elif t == 1 %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t1 VALUE=0
    {% elif t == 2 %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t2 VALUE=0
    {% else %}
        SET_GCODE_VARIABLE MACRO=_FILAMENT_STATE VARIABLE=new_t3 VALUE=0
    {% endif %}

[gcode_macro _PURGE_NEW_FILAMENTS]
description: Purge each tool marked new AND used in this print, then CLEAR that tool
variable_purge_length: 140
variable_purge_height: 0.4
variable_purge_e: 140.0
variable_purge_x0: 2.0
variable_purge_x1: 3.0
variable_purge_x2: 303.0
variable_purge_x3: 304.0
variable_purge_y: 0.0
variable_purge_feedrate: 900
gcode:
    {% set st = printer["gcode_macro _FILAMENT_STATE"] %}
    {% set length = printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_length %}
    {% set height = printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_height %}
    {% set e_move = printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_e %}
    {% set y0 = printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_y %}
    {% set y1 = y0 + length %}
    {% set fr = printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_feedrate %}
    {% set xs = [
        printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_x0,
        printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_x1,
        printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_x2,
        printer["gcode_macro _PURGE_NEW_FILAMENTS"].purge_x3
    ] %}
    {% set flags = [st.new_t0, st.new_t1, st.new_t2, st.new_t3] %}
    # Bu print'te fiilen kullanılacak/ısıtılacak kafalar (START_PRINT'ten gelir)
    {% set used = [
        params.USED0|default(0)|int,
        params.USED1|default(0)|int,
        params.USED2|default(0)|int,
        params.USED3|default(0)|int
    ] %}
    {% for t in range(4) %}
        {% if flags[t]|int == 1 and used[t]|int == 1 %}
            T{t}
            G90
            G92 E0
            G1 X{xs[t]} Y{y0} Z{height} F{fr}
            G92 E0
            G1 Y{y1} E{e_move} F{fr}
            G92 E0
            CLEAR_FILAMENT_NEW TOOL={t}
        {% endif %}
    {% endfor %}

# In START_PRINT (after heat / tool ready, before first layer):
#   _PURGE_NEW_FILAMENTS
```

## input_shaper.cfg
```
[mcu cp_bed]
restart_method: command

[temperature_sensor cp_bed]
sensor_type: temperature_mcu
sensor_mcu: cp_bed
min_temp: 0
max_temp: 75


[adxl345 y-motor]
axes_map: y,x,z


# [resonance_tester]
# accel_chip: adxl345
# probe_points:
#     100, 100, 20  


# [duplicate_pin_override]


# [gcode_button lc_drdy]
# press_gcode:
#   RESPOND MSG="LC_DRDY_LOW"
# release_gcode:
#   RESPOND MSG="LC_DRDY_HIGH"


[load_cell bed_pin]
sensor_type: ads1220


# sample_rate: 45
sample_rate: 90


counts_per_gram : 48.3118
reference_tare_counts: 87072
input_mux: AIN0_AIN1
gain: 128
vref: REF0

#*# [load_cell bed_pin]
#*# counts_per_gram = 26.48
#*# reference_tare_counts = 32030


#[shaketune]
# result_folder: ~/printer_data/config/ShakeTune_results
#    Path where the processed results will be stored. If the folder doesn't exist,
#    it will be automatically created. You can change this if you'd like to store 
#    results in a different location.
# number_of_results_to_keep: 10
#    This setting defines how many results you want to keep in the result folder.
#    Once the specified number is exceeded, older results will be automatically deleted
#    to free up space on the SD card and avoid cluttering the results folder.
# keep_raw_data: False
#    If set to True, Shake&Tune will store both the processed graphs and the raw accelerometer
#    .stdata files in the results folder. This can be useful for debugging or archiving purposes.
#    Please always attach them when reporting any issues on GitHub or Discord.
# show_macros_in_webui: True
#    Mainsail and Fluidd doesn't create buttons for system commands (macros that are not part
#    of the printer.cfg file). This option allow Shake&Tune to inject them into the webui at runtime.
#    If set to False, the macros will be hidden but still accessible from the console by typing
#    their names manually, which can be useful if you prefer to encapsulate them into your own macros.
# timeout: 600
#    This defines the maximum processing time (in seconds) to allows to Shake&Tune for generating 
#    graphs from a .stdata file. 10 minutes should be more than enough in most cases, but if you have
#    slower hardware (e.g., older SD cards or low-performance devices), increase it to prevent timeouts.
# measurements_chunk_size: 2
#    Each Shake&Tune command uses the accelerometer to take multiple measurements. By default,
#    Shake&Tune will write a chunk of data to disk every two measurements, and at the end of the
#    command will merge these chunks into the final .stdata file for processing. "2" is a very
#    conservative setting to avoid Klipper Timer Too Close errors on lower end devices with little
#    RAM, and should work for everyone. However, if you are using a powerful computer, you may
#    wish to increase this value to keep more measurements in memory (e.g., 15-20) before writing
#    the chunk and avoid stressing the filesystem too much.
# max_freq: 200
#    This setting defines the maximum frequency at which the calculation of the power spectral density
#    is cutoff. The default value should be fine for most machines and accelerometer combinations and
#    avoid touching it unless you know what you're doing.
# dpi: 300
#    Controls the resolution of the generated graphs. The default value of 300 dpi was optimized
#    and strikes a balance between performance and readability, ensuring that graphs are clear
#    without using too much RAM to generate them. Usually, you shouldn't need to change this value.
```

## bed_pin_tool_positions.json
```
{
    "T0": {
        "top_x": 252.35999999999987,
        "top_y": 305.19500000000005,
        "side_z_margin": 1.0,
        "left_x": 243.0,
        "right_x": 259.0,
        "front_y": 300.0,
        "back_y": 311.0,
        "last_measured_top_z": 1.7900000000000105
    },
    "T1": {
        "top_x": 252.19999999999985,
        "top_y": 305.295,
        "side_z_margin": 1.0,
        "left_x": 243.0,
        "right_x": 259.0,
        "front_y": 300.0,
        "back_y": 311.0,
        "last_measured_top_z": 1.730000000000006
    },
    "T2": {
        "top_x": 250.615,
        "top_y": 305.09000000000003,
        "side_z_margin": 1.0,
        "left_x": 243.0,
        "right_x": 259.0,
        "front_y": 300.0,
        "back_y": 311.0,
        "last_measured_top_z": 1.770000000000006
    },
    "T3": {
        "top_x": 250.13000000000002,
        "top_y": 304.645,
        "side_z_margin": 1.0,
        "left_x": 243.0,
        "right_x": 259.0,
        "front_y": 300.0,
        "back_y": 311.0,
        "last_measured_top_z": 1.8200000000000105
    }
}
```

## bed_pin_offsets.json
```
{
    "T0": {
        "x": 0.0,
        "y": 0.0,
        "z": 0.0
    },
    "T1": {
        "x": -0.160000000000025,
        "y": 0.0999999999999659,
        "z": -0.060000000000004494
    },
    "T2": {
        "x": -1.7449999999998624,
        "y": -0.10500000000001819,
        "z": -0.02000000000000446
    },
    "T3": {
        "x": -2.2299999999998477,
        "y": -0.5500000000000682,
        "z": 0.030000000000000027
    }
}
```
