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
- Two kinds of load cell, both ADS1220:
  1. The Z probe: [load_cell_probe] in the first toolhead's head board (chroma_head_1.cfg, MCU cp_Head_1). The nozzle
     itself touches the bed and the load cell in the head triggers at trigger_force 25 g (sample_rate 600,
     counts_per_gram 48.31, force_safety_limit 2000 g). Homing Z, PROBE and the bed mesh use it.
  2. The bed pin: [load_cell bed_pin], a load cell under a small pin in the bed. Nozzles touch the pin from above and
     from the sides; it is used for tool offset calibration (bed_pin_calibration), the axis slip test and pressure
     advance work.
- Each toolhead also has its own ADXL345 accelerometer (t0..t3) for input shaper calibration.
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
QUADRO_CUSTOM_BED_MESH [PROFILE=default] [REPEATS=2]: probes with the nozzle load cell probe (not the bed pin), with a
mechanical settle and a manual load cell tare before every point. It runs complete probing passes over Klipper's
configured mesh (e.g. 9x9), averages every point across the passes, and builds one Klipper mesh from the averages (less noise than a
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
Klipper's load cell probe with Co Print changes, used for the nozzle-contact Z probe in the head. The bed pin is a
separate load cell (LOAD_CELL=bed_pin) read with LOAD_CELL_TARE and force readings in grams.

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
