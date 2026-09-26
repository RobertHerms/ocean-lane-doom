# Ocean Lane: Imps in the House

A Doom-style first-person shooter set in the Ocean Lane house. It's a fork of the Ocean Lane walkthrough (three.js,
baked lighting).

The two children have grown to six feet and behave like Doom's imps:

- they wander until they see you or hear gunfire;
- then they chase you through the house, up the stairs and through doors;
- they throw fireballs and claw at close range;
- they flinch when hit, and burn away when they die.

You have the classic arsenal and a status bar laid out like the 1993 one.

Open `index.html` over HTTP (for example `python -m http.server`), pick **New Game** and a skill level.

## Controls

| Keys | Action |
| --- | --- |
| W A S D / arrows | Move, strafe, turn (Alt + ←/→ or `,` `.` also strafe) |
| Mouse | Look (click the view to capture the pointer) |
| Left click / Ctrl | Fire |
| Space / E / right click | Open doors (use) |
| 1–7, mouse wheel | Weapons. 1 toggles fist / chainsaw, 3 toggles shotgun / super shotgun |
| Shift | Walk (always-run is on by default; see Options) |
| Tab / M | Automap (+ / − or the wheel to zoom) |
| Esc | Menu |
| J · X | Jump · crouch |

On a touch screen:

- the left stick moves and the right stick looks;
- FIRE, USE, GUN (next weapon), MAP and pause are buttons.

## Weapons

These follow Doom's timing, damage and ammo use:

- fist and chainsaw
- pistol
- shotgun and super shotgun
- chaingun
- rocket launcher
- plasma gun
- BFG 9000

Ammo, health, armour, a backpack, berserk, soul sphere and megasphere lie around the house. Three keycards open the
locked closets, and four secret rooms count toward the end-of-level tally. Leave by the front door to finish.

## Skills

| Skill | Effect |
| --- | --- |
| I'm too young to babysit | half damage, double ammo |
| Hey, not too rowdy | |
| Sugar rush | |
| Ultra-Tantrum | more imps |
| Bedtime Nightmare! | double ammo, imps respawn, fast fireballs |

## Credits

The house engine and the children come from the Ocean Lane walkthrough.

Every model, texture, font, sound effect and the music in this fork are generated in code. No assets from the original
game are used.

DOOM is a trademark of id Software. This is a non-commercial fan tribute and isn't affiliated with or endorsed by
id Software.
