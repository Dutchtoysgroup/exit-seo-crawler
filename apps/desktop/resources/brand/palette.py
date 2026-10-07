"""EXIT house-style palette for the renderer (see src/renderer/src/styles.css).

Converts the marketing dashboard's oklch tokens to the `R G B` triplets the
Tailwind scales read. Run `python3 palette.py` and paste the printed lines
over the `--sf-*` and `--c-blue-*` lines in styles.css.

- surface (`--sf-*`): dark = near-neutral with a whisper of green (hue 145),
  light = warm green-tinted greys (hue 128), as in the dashboard.
- `--c-blue-*` carries EXIT green, because blue is this UI's interaction
  colour. 500 is EXIT "natuurlijk groen" #78be20, 600 the dashboard primary
  oklch(0.55 0.16 128). The light theme mirrors shades the same way the
  upstream palette does (950/900 tints become 50/100, and so on).
"""
import math


def oklch_to_rgb(L, C, h):
    a = C * math.cos(math.radians(h))
    b = C * math.sin(math.radians(h))
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    def enc(x):
        x = max(0.0, min(1.0, x))
        return round(255 * (12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055))

    return enc(r), enc(g), enc(bb)


DARK_SF = {'50': (0.985, 0.002), '100': (0.97, 0.003), '200': (0.922, 0.004), '300': (0.87, 0.004),
           '400': (0.74, 0.006), '500': (0.58, 0.006), '600': (0.45, 0.006), '700': (0.37, 0.006),
           '800': (0.285, 0.006), '850': (0.245, 0.006), '900': (0.215, 0.006), '950': (0.175, 0.006)}
LIGHT_SF = {'50': (0.13, 0.003), '100': (0.17, 0.004), '200': (0.27, 0.015), '300': (0.36, 0.008),
            '400': (0.44, 0.006), '500': (0.56, 0.008), '600': (0.72, 0.012), '700': (0.885, 0.016),
            '800': (0.935, 0.014), '850': (0.952, 0.012), '900': (0.968, 0.010), '950': (0.985, 0.004)}
GREEN = {'50': (0.975, 0.025), '100': (0.950, 0.055), '200': (0.905, 0.10), '300': (0.845, 0.15),
         '400': (0.775, 0.185), '800': (0.430, 0.115), '900': (0.370, 0.095), '950': (0.265, 0.070)}
MIRROR = {'50': '950', '100': '950', '200': '900', '300': '800', '400': '700', '500': '600',
          '600': '700', '700': '300', '800': '200', '900': '100', '950': '50'}
STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']

sf_dark = {k: oklch_to_rgb(L, C, 145) for k, (L, C) in DARK_SF.items()}
sf_light = {k: oklch_to_rgb(L, C, 128) for k, (L, C) in LIGHT_SF.items()}
green = {k: oklch_to_rgb(L, C, 129) for k, (L, C) in GREEN.items()}
green['500'] = (0x78, 0xBE, 0x20)                 # EXIT natuurlijk groen
green['600'] = oklch_to_rgb(0.55, 0.16, 128)      # dashboard --primary
green['700'] = oklch_to_rgb(0.49, 0.14, 128)
green_light = {k: green[v] for k, v in MIRROR.items()}


def trip(t):
    return ' '.join(map(str, t))


def hexc(t):
    return '#%02x%02x%02x' % t


if __name__ == '__main__':
    for title, sf in (('dark :root', sf_dark), ("html[data-theme='light']", sf_light)):
        print(f'/* {title} */')
        for k in ['50', '100', '200', '300', '400', '500', '600', '700', '800', '850', '900', '950']:
            print(f'    --sf-{k}: {trip(sf[k])};')
    for title, g in (('dark :root', green), ("html[data-theme='light']", green_light)):
        print(f'/* {title} */')
        print('    ' + ' '.join(f'--c-blue-{k}: {trip(g[k])};' for k in STEPS))
    print('/* tailwind accent 500 / 600 */', hexc(green['600']), hexc(green['700']))
    print('/* grid + UI_THEME_BACKGROUND */ dark', hexc(sf_dark['950']), 'light', hexc(sf_light['950']))
