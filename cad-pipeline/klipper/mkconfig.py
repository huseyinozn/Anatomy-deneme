"""printer_data/config -> quadro3d/printer-config.json for the simulator: every section Klipper would load,
minus wiring details (pins, buses, serial ports, driver tuning), plus the bed pin calibration files."""
import json, re, sys, pathlib
cfg = json.load(open(sys.argv[1]))
root = pathlib.Path(sys.argv[2])
DROP_SECTIONS = re.compile(r"^(mcu|tmc2209 |adxl345|verify_heater|heater_fan|temperature_sensor (cp_|main|Host)|stepper )")
DROP_KEYS = re.compile(r"pin|serial|uart|spi|i2c|canbus|sensor_type|pullup|inline_resistor|sense_resistor|restart_method|cs_|data_ready|input_mux|gain|vref|sample_rate|counts_per_gram|reference_tare|interpolate|microsteps|stealthchop|driver_|run_current|^path$|filename")
out = {}
for name, opts in cfg.items():
    if DROP_SECTIONS.match(name): continue
    out[name] = {k: v for k, v in opts.items() if not DROP_KEYS.search(k) or k in ("gcode",)}
# keep the driver thresholds the homing macros read through printer.configfile.settings
for n in ("tmc2209 stepper stepper_y1", "tmc2209 stepper stepper_y2"):
    if n in cfg: out[n] = {"driver_sgthrs": cfg[n].get("driver_sgthrs", "0")}
doc = {"sections": out,
       "bedPin": json.load(open(root / "bed_pin_tool_positions.json")),
       "bedPinOffsets": json.load(open(root / "bed_pin_offsets.json"))}
json.dump(doc, open(sys.argv[3], "w"), ensure_ascii=False, separators=(",", ":"))
print(len(out), "sections")
