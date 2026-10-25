#!/usr/bin/env python3
"""Build knowledge.md, the reference the Ask worker gives Claude: guide.md, then Co Print's own Klipper modules and the
printer's configuration and macros. Wiring (pins, serial ports, MCU ids) is left out.
Usage: build-knowledge.py <klipper download dir with klippy/ and printer_data/config/>"""
import pathlib, re, sys

src = pathlib.Path(sys.argv[1])
here = pathlib.Path(__file__).parent
# pa_autotune, coprint_leds, quadro_input_shaper and load_cell_probe (mostly stock Klipper) are covered by the guide only, keeping the whole
# reference under the 100K-token prompt size above which the model is billed at a higher rate
MODULES = ["quadro_parallel_carriage.py", "bed_pin_calibration.py", "axis_slip_test.py", "quadro_bed_mesh.py",
           ]
CONFIGS = ["printer.cfg", "tool_map.cfg", "cp_macro.cfg", "cp_macro_2.cfg", "calibration_wizard.cfg",
           "purge_filament_macros.cfg", "input_shaper.cfg", "bed_pin_tool_positions.json", "bed_pin_offsets.json"]
WIRING = re.compile(r"^\s*#?\s*(serial|canbus_uuid|uuid|[a-z_]*pins?|cs_pin|spi_\w+|i2c_\w+|sensor_pin|"
                    r"heater_pin|step_pin|dir_pin|enable_pin|uart_pin|diag_pin|endstop_pin)\s*[:=]", re.I)
WIRED_PATH = re.compile(r"/dev/serial|usb-0:")

out = [(here / "guide.md").read_text()]
out.append("\n# Source: Co Print Klipper modules (klippy/extras)\n")
for name in MODULES:
    out.append("\n## %s\n```python\n%s\n```\n" % (name, (src / "klippy" / name).read_text().rstrip()))
out.append("\n# Source: printer configuration and macros (printer_data/config, wiring removed)\n")
for name in CONFIGS:
    lines = (src / "printer_data/config" / name).read_text().splitlines()
    kept = [l for l in lines if not WIRING.match(l) and not WIRED_PATH.search(l)]
    out.append("\n## %s\n```\n%s\n```\n" % (name, "\n".join(kept).rstrip()))
(here / "knowledge.md").write_text("".join(out))
print("knowledge.md", sum(len(o) for o in out), "chars")
