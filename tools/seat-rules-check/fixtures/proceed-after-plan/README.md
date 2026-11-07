# Example Game: town mod

This folder is a mod for Example Game. The game loads every file under `data/` when it starts.

- `data/items.json` lists the items the mod adds.
- `data/npcs.json` lists the people who stand in the town.
- `scripts/` holds small Lua scripts the game runs for an npc's behaviour.

The game has a command-line packer, `egpack`, that turns this folder into a `.egmod` file.
Nothing here has been tested with a shop or trading screen yet.
