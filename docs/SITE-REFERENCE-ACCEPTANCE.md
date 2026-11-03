# Site coordinate reference acceptance

Updated 3 November 2026. The site workflow accepts manually entered coordinates, measured rectangular/corridor extents and polygon corners. It provides a local concept-model reference, without embedded imagery, survey approval or CRS transformations.

Creating a community or infrastructure site commits its location and fitted extent together. Rectangular corners use the local inverse projection and width-axis angle counterclockwise from east. Polygon center, true area and bounding axes derive from its corners; sorting width/depth also rotates the width axis. Zero coordinates remain valid. Invalid inputs and new extents below one metre in either dimension produce an accessible error before a project update. Polygon corners and shape survive reopening, and unit switches convert dimensions.

The local boundary fill and outline use the same east/north coordinates. Loading saved/shared sites does not request provider imagery. The form and scene disclose that scope. The explicit Google Earth link includes entered coordinates and opens an external service.

Fixtures check an 80 × 60 m rectangle at latitudes 0°, 60° and −60° with rotations 0°, 35° and 90°, including independent great-circle lengths; metre/foot conversion; polygon center/area/axes; atomic saves; serialization; unit changes; invalid inputs; and local fill alignment without image requests. Browser checks use the real site component in a synthetic localhost fixture, without production accounts or projects.

Existing references are not migrated automatically. Canvas extents retain their existing display-unit rounding while authored boundary coordinates retain separate precision. Stored corridor/runway bearings follow compass conventions, but the airport schematic does not apply runway heading as scene rotation. Infrastructure fitting remains a preliminary heuristic. Survey north/CRS, arbitrary GIS extents, terrain and project engineering require separate acceptance.
