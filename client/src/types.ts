import type { EngineeringDesignBasis } from "./lib/engineeringBasis";

export const PROJECT_TYPES = [
  "house",
  "residential",
  "villa-community",
  "townhouse",
  "commercial",
  "highway",
  "airport",
  "ports",
  "dams",
] as const;

export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  house: "House & Interiors",
  residential: "Residential Building",
  "villa-community": "Villa Community",
  townhouse: "Townhouse Community",
  commercial: "Commercial Building",
  highway: "Highway & Roadways",
  airport: "Airport",
  ports: "Ports & Harbours",
  dams: "Dams & Spillways",
};

export interface User {
  id: string;
  email: string;
  username?: string | null;
  emailVerified?: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  passwordChangedAt: number;
  plan: string;
  planExpiresAt: number | null;
  country: string;
  phone: string | null;
  accountType: "individual" | "business";
  gstin: string | null;
}

export interface Project {
  id: string;
  name: string;
  projectType: ProjectType;
  widthMm: number;
  depthMm: number;
  createdAt: number;
  updatedAt: number;
  hasPhoto: boolean;
  revision: number;
  role?: "owner" | "editor" | "viewer";
  folder?: string;
  archived?: boolean;
  isTemplate?: boolean;
}

export interface ProjectDetail extends Project {
  design: Design | null;
}

/** Construction planning activities linked to model objects by phaseId. */
export interface ConstructionPhase {
  id: string;
  name: string;
  start: number;
  end: number;
  color?: string;
  durationDays?: number;
  dependsOn?: string[];
  crewSize?: number;
  costEstimate?: number;
  earliestStartDay?: number;
  progressPercent?: number;
  actualCost?: number;
}

export interface ConstructionScheduleBaseline {
  capturedAt: string;
  projectStartDate?: string;
  entries: Array<{ phaseId: string; startDay: number; endDay: number; costEstimate: number }>;
}

export interface ConstructionScheduleSettings {
  mode: "manual" | "dependency";
  /** YYYY-MM-DD. Durations and offsets use calendar days, including weekends. */
  startDate?: string;
  baseline?: ConstructionScheduleBaseline;
}

export interface CameraWaypoint {
  id: string;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
}

/** Presentation state and optional dependency schedule for 4D planning review. */
export interface VisualizationSettings {
  enabled: boolean;
  time: number;
  playing: boolean;
  walkthrough: boolean;
  renderQuality?: "performance" | "balanced" | "presentation";
  cameraPath?: CameraWaypoint[];
  phases: ConstructionPhase[];
  schedule?: ConstructionScheduleSettings;
}

export interface CollaborationItem {
  id: string;
  userId?: string;
  kind: "comment" | "issue";
  body?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMember {
  userId: string;
  email: string;
  username: string | null;
  role: "owner" | "editor" | "viewer";
  createdAt?: number;
}

export interface ProjectObjectLock {
  objectId: string;
  userId: string;
  token?: string;
  expiresAt: number;
  updatedAt: number;
}

export interface CollaborationPresence {
  projectId: string;
  count: number;
  users: { userId: string; connections: number }[];
}

export interface ProjectRevision {
  id: string;
  name: string;
  projectType: ProjectType;
  widthMm: number;
  depthMm: number;
  createdAt: number;
}

export interface ProjectShareLink {
  id: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
  active: boolean;
}

export interface SharedProject extends ProjectDetail {
  readOnly: true;
  expiresAt: number;
}

export interface AuditEvent {
  id: number;
  action: string;
  detail: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

export interface AuditStats {
  activeSessions: number;
  secretsCount: number;
  projectsCount: number;
  failedLogins24h: number;
  logins24h: number;
  signupsEver: number;
  enabled2fa: boolean;
  lastLogin: number | null;
}

export interface SessionInfo {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  current: boolean;
}

export interface PaymentRecord {
  id: string;
  provider: string;
  method: string;
  plan: string;
  amount: number;
  currency: string;
  status: string;
  provider_order_id: string | null;
  completed_at: number | null;
  created_at: number;
}

export interface Plan {
  id: string;
  name: string;
  price: number;
  currency: string;
  symbol: string;
  digits: number;
  periodDays: number;
  tagline: string;
}

export interface PaymentMethodInfo {
  method: "upi" | "card" | "paypal";
  label: string;
  provider: string;
}

/* --------------------------------- Design -------------------------------- */

export interface RoomConfig {
  widthMm: number;
  depthMm: number;
  wallHeightMm: number;
  wallColor: string;
  floorColor: string;
}

export type MepElementKind = "duct" | "pipe" | "cable-tray" | "equipment" | "fixture";
export type MepSystemType = "hvac-supply" | "hvac-return" | "plumbing-supply" | "plumbing-drain" | "electrical-power" | "fire-protection" | "controls";

export interface MepZone {
  id: string;
  name: string;
  areaM2: number;
  occupancy: number;
  levelId?: string;
}

export interface MepPoint {
  x: number;
  y: number;
  z: number;
}

/** Preliminary coordination geometry; not a fabrication or code-compliant design. */
export interface MepElement {
  id: string;
  kind: MepElementKind;
  name: string;
  route: MepPoint[];
  width: number;
  height: number;
  diameter: number;
  color: string;
  visible: boolean;
  /** Optional planning input; absence preserves legacy elements. */
  ratedPowerKw?: number;
  levelId?: string;
  system?: MepSystemType;
  zoneId?: string;
  connectedTo?: string[];
  supportSpacingM?: number;
  family?: ParametricFamilyMetadata;
  phaseId?: string;
}

export interface MepPlanningInputs {
  areaM2: number;
  ceilingHeightM: number;
  occupancy: number;
  airChangesPerHour: number;
  coolingLoadWPerM2: number;
  designAirVelocityMps: number;
  pipeVelocityMps: number;
  plumbingFlowLps: number;
  minimumClearanceM: number;
  electricalDemandFactor: number;
  designPressurePa?: number;
  designVoltageV?: number;
  codeProfileId?: string;
}

export interface MepDesign {
  version: 1;
  enabled: boolean;
  elements: MepElement[];
  planning?: MepPlanningInputs;
  zones?: MepZone[];
}

export interface FurnitureItem {
  id: string;
  type: string;
  name: string;
  x: number;
  z: number;
  rotationDeg: number;
  scale: number;
  color: string;
  mount?: FurnitureMount;
  mountWall?: RoomWall;
  mountHeightM?: number;
  finish?: "matte" | "satin" | "glossy" | "metallic" | "glass";
  phaseId?: string;
}

export type FurnitureMount = "unassigned" | "floor" | "wall" | "ceiling";

export type RoomOpeningKind = "window" | "door";
export type RoomWall = "north" | "east" | "south" | "west";

export interface RoomOpening {
  id: string;
  kind: RoomOpeningKind;
  wall: RoomWall;
  offsetM: number;
  widthM: number;
  heightM: number;
  sillM: number;
  family?: ParametricFamilyMetadata;
}

export interface CurtainConfig {
  enabled: boolean;
  style: "sheer" | "blackout" | "roman" | "panel";
  color: string;
  wall: "north" | "south" | "east" | "west";
  heightPercent: number;
  widthPercentPerPanel: number;
}

/* ------------------------- Community / building wizard ------------------------- */

export type UnitSystem = "m" | "yd" | "ft";
export type BuildingBranch = "residential" | "commercial";
export type ResidentialStyle = "high-rise" | "individual-house" | "villa-community" | "townhouse";
export type CommercialStyle = "office" | "hotel" | "resort";
export type ParkingMode = "none" | "surface" | "underground";
export type DoorFacing = "north" | "east" | "south" | "west";

export interface LandSite {
  unit: UnitSystem;
  width: number;
  depth: number;
}

export type TerrainProfileAxis = "x" | "z";

export interface TerrainSample {
  x: number;
  z: number;
  elevationM: number;
}

/** Local terrain controls. Survey samples override the deterministic fallback surface. */
export interface TerrainSettings {
  enabled: boolean;
  baseElevationM: number;
  reliefM: number;
  contourIntervalM: number;
  contoursVisible: boolean;
  profileAxis: TerrainProfileAxis;
  profileOffsetM: number;
  source?: "procedural" | "survey";
  projectCrs?: string;
  localOriginEasting?: number;
  localOriginNorthing?: number;
  samples?: TerrainSample[];
}

export interface UndergroundParking {
  levels: number;
  floorHeight: number;
  foundationDepth: number;
  rampWidth: number;
  rampLength: number;
  rampSlope: number;
  pillarSpacingX: number;
  pillarSpacingZ: number;
  bayWidth: number;
  bayLength: number;
  bayCols: number;
  bayRows: number;
  liftLobby: boolean;
  stairLobby: boolean;
  /** Custom user-defined breadth (width) of underground parking in meters */
  parkingWidthM?: number;
  /** Custom user-defined length of underground parking in meters */
  parkingLengthM?: number;
}

export interface Parking {
  mode: ParkingMode;
  surfaceBays: number;
  underground?: UndergroundParking;
}

export interface AmenityData {
  id: string;
  kind: string;
  x: number;
  z: number;
  rotY: number;
  w: number;
  d: number;
  h: number;
  /** Optional overrides for generated objects (offline intent → object). */
  label?: string;
  color?: string;
  shape?: string;
  phaseId?: string;
}

export type DraftElementKind = "line" | "polyline" | "arc" | "spline" | "rectangle" | "circle" | "dimension" | "wall" | "slab" | "column" | "beam" | "roof";

export type ParametricConstraintKind = "alignment" | "coincident" | "collinear" | "parallel" | "perpendicular" | "level" | "equal";

export type ParametricConstraintAnchor = "center" | "start" | "end" | "midpoint";

export type DraftGrip = "width-start" | "width-end" | "depth-start" | "depth-end";

/** Optional parametric intent. All fields are additive for older saved designs. */
export interface ParametricFamilyMetadata {
  libraryId?: string;
  family?: string;
  type?: string;
  instance?: string;
  typeParameters?: Record<string, number | string | boolean>;
  instanceParameters?: Record<string, number | string | boolean>;
  hostId?: string;
  levelId?: string;
  metadata?: Record<string, string>;
}

export interface ParametricLocks {
  x?: boolean;
  z?: boolean;
  width?: boolean;
  depth?: boolean;
  height?: boolean;
  rotation?: boolean;
  level?: boolean;
}

export interface ParametricConstraint {
  id: string;
  kind: ParametricConstraintKind;
  targetId?: string;
  axis?: "x" | "z" | "both";
  anchor?: ParametricConstraintAnchor;
  targetAnchor?: ParametricConstraintAnchor;
  locked?: boolean;
}

export interface DraftElement {
  id: string;
  kind: DraftElementKind;
  x: number;
  z: number;
  w: number;
  d: number;
  h?: number;
  rotationDeg: number;
  color: string;
  /** Optional local-space path geometry for CAD curves and polylines. */
  points?: { x: number; z: number }[];
  radiusM?: number;
  startAngleDeg?: number;
  endAngleDeg?: number;
  /** Optional civil annotation metadata; geometry remains editable in metres. */
  civilKind?: "contour" | "alignment" | "grade";
  elevationM?: number;
  gradePct?: number;
  label?: string;
  family?: ParametricFamilyMetadata;
  locks?: ParametricLocks;
  constraints?: ParametricConstraint[];
  phaseId?: string;
  /** Optional CAD visibility/locking. Visibility never changes engineering quantities. */
  visible?: boolean;
  locked?: boolean;
  material?: string;
  /** Rectangular through-openings in a wall's local X/Y plane; all measurements in metres. */
  openings?: { id: string; kind: "door" | "window" | "void"; offsetM: number; widthM: number; heightM: number; sillM: number }[];
}

export interface DraftingSettings {
  gridVisible: boolean;
  gridSize: number;
  snapEnabled: boolean;
  orthogonal: boolean;
  angleIncrement: number;
  alignment: boolean;
  endpointSnap?: boolean;
  midpointSnap?: boolean;
  centerSnap?: boolean;
  snapTolerance?: number;
}

export interface DesignLayer {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  locked?: boolean;
  frozen?: boolean;
  lineweight?: number;
}

export interface DimensionStyle {
  name: string;
  textHeightMm: number;
  arrowSizeMm: number;
  precision: number;
  units: "m" | "mm" | "ft-in";
  suppressTrailingZeros: boolean;
}

export interface TechnicalGraphicsSettings {
  displayMode: "shaded" | "shaded-edges" | "hidden-line" | "wireframe";
  lineweights: {
    walls: number;
    structure: number;
    mep: number;
    furniture: number;
    dimensions: number;
    annotations: number;
    site: number;
  };
  dimensionStyle: DimensionStyle;
  showAxes: boolean;
  showNorthArrow: boolean;
  showScaleBar: boolean;
  showElevationMarkers: boolean;
}

export type SectionAxis = "x" | "y" | "z";

export interface SectionSettings {
  enabled: boolean;
  axis: SectionAxis;
  /** Rotation around the vertical axis for an angled vertical section plane. */
  rotationDeg?: number;
  /** Lower bound of the visible interval, in scene metres. */
  offset: number;
  /** Visible interval length, in scene metres. */
  depth: number;
}

export type ReviewSeverity = "note" | "warning" | "blocker";
export type ReviewStatus = "open" | "resolved";

export interface ReviewMarker {
  id: string;
  text: string;
  severity: ReviewSeverity;
  status: ReviewStatus;
  x: number;
  z: number;
  targetIds?: string[];
  category?: string;
  assignee?: string;
  dueDate?: string;
  workflowStatus?: "open" | "in-progress" | "resolved";
  createdAt?: string;
  updatedAt?: string;
  sourceFindingId?: string;
  groupKey?: string;
  bcfTopicGuid?: string;
  comments?: ReviewComment[];
  viewpoint?: ReviewViewpoint;
}

export interface ReviewComment {
  id: string;
  text: string;
  author?: string;
  createdAt: string;
}

export interface ReviewViewpoint {
  position: [number, number, number];
  direction: [number, number, number];
  up: [number, number, number];
  fieldOfView?: number;
  viewToWorldScale?: number;
  cameraType?: "perspective" | "orthographic";
  componentGuids?: string[];
}

export interface DesignReview {
  markers: ReviewMarker[];
}

export type DocumentationViewKind = "plan" | "elevation" | "section" | "detail" | "schedule";
export type DocumentationOrientation = "north" | "east" | "south" | "west" | "custom";

export interface DocumentationView {
  id: string;
  name: string;
  kind: DocumentationViewKind;
  scale: string;
  orientation: DocumentationOrientation;
  levelId?: string;
  /** Explicit vertical world-metre cut plane. Absent values never imply a section. */
  section?: { axis: "x" | "z"; offsetM: number };
  visible: boolean;
}

export interface DocumentationSheet {
  id: string;
  number: string;
  name: string;
  viewIds: string[];
  titleBlock?: string;
  scheduleIds?: string[];
  revisionIds?: string[];
}

export interface DocumentationRevision {
  id: string;
  number: string;
  date: string;
  description: string;
  author: string;
}

export interface DocumentationAnnotation {
  id: string;
  text: string;
  tag?: string;
  viewId?: string;
  targetId?: string;
  x?: number;
  z?: number;
}

export interface DocumentationSchedule {
  id: string;
  name: string;
  fields: string[];
  category: "rooms" | "furniture" | "levels" | "mep" | "objects";
  filters?: { field: string; operator: "contains" | "equals" | "greater-than" | "less-than"; value: string }[];
  sortField?: string;
  sortDirection?: "asc" | "desc";
  groupBy?: string;
}

export interface DocumentationMetadata {
  version: 1;
  projectNumber: string;
  client: string;
  author: string;
  status: "draft" | "review" | "issued";
  issueDate: string;
  titleBlock: string;
  views: DocumentationView[];
  sheets: DocumentationSheet[];
  annotations: DocumentationAnnotation[];
  schedules: DocumentationSchedule[];
  revisions: DocumentationRevision[];
}

export interface BuildingLevel {
  id: string;
  name: string;
  elevation: number;
  floorHeight: number;
}

export type StructuralGridAxis = "x" | "z";

export interface StructuralGridLine {
  id: string;
  axis: StructuralGridAxis;
  label: string;
  position: number;
  extent: number;
  color: string;
}

/** Screening inputs only; these are not design-code or permit parameters. */
export interface StructuralSettings {
  enabled: boolean;
  deadLoadKPa: number;
  liveLoadKPa: number;
  concreteStrengthMPa: number;
  soilBearingKPa: number;
  columnWidthM: number;
  columnDepthM: number;
  beamWidthM: number;
  beamDepthM: number;
  footingWidthM: number;
  footingDepthM: number;
  safetyFactor: number;
  windPressureKPa?: number;
  seismicCoefficient?: number;
  loadCombinations?: StructuralLoadCombination[];
  material?: "reinforced-concrete" | "steel" | "masonry";
  soilType?: "unknown" | "rock" | "dense-sand" | "stiff-soil" | "soft-soil";
  windExposure?: "unknown" | "urban" | "open" | "coastal";
  seismicSiteClass?: "unknown" | "A" | "B" | "C" | "D" | "E" | "F";
  occupancyCategory?: "residential" | "commercial" | "assembly" | "essential" | "unknown";
  driftLimitRatio?: number;
  codeProfileId?: string;
}

export interface StructuralLoadCombination {
  id: string;
  label: string;
  deadFactor: number;
  liveFactor: number;
  windFactor: number;
  seismicFactor: number;
}

/** Configurable planning profile. This is not a code certification or permit basis. */
export interface EngineeringCodeProfile {
  id: string;
  name: string;
  unitSystem: "SI" | "imperial";
  loadFactors: { dead: number; live: number; wind: number; seismic: number };
  wind: { pressureKPa: number; importanceFactor: number; exposureFactor: number };
  seismic: { coefficient: number; importanceFactor: number; responseFactor: number };
  materials: { concreteMPa: number; steelMPa: number; masonryMPa: number; soilBearingKPa: number };
  occupancy: { category: StructuralSettings["occupancyCategory"]; liveLoadKPa: number; peoplePerM2: number };
  assumptions: { driftLimitRatio: number; safetyFactor: number; designAirVelocityMps: number; pipeVelocityMps: number; electricalDemandFactor: number };
}

export type ComplianceIssueSeverity = "error" | "warning" | "review";
export type ComplianceCategory = "dimensions" | "life-safety" | "occupancy" | "floor-heights" | "structural" | "mep" | "site" | "documentation";

/** Planning reference only. Profile names do not represent certification or a jurisdictional code basis. */
export interface ComplianceProfile {
  id: string;
  name: string;
  jurisdictionStyle: string;
  edition: string;
  scope: string;
  disclaimer: string;
  thresholds: {
    minRoomWidthM: number;
    minRoomDepthM: number;
    minDoorWidthM: number;
    minClearanceM: number;
    minFloorHeightM: number;
    maxSiteSlopePct: number;
    peoplePerM2: number;
  };
}

export interface ComplianceIssue {
  id: string;
  severity: ComplianceIssueSeverity;
  category: ComplianceCategory;
  message: string;
  basis: string;
}

export interface ComplianceReport {
  profile: ComplianceProfile;
  issues: ComplianceIssue[];
  generatedAt: string;
}

export interface TowerData {
  id: string;
  label: string;
  x: number;
  z: number;
  rotY?: number;
  floors: number;
  unitsPerFloor: number;
  unitWidth: number;
  unitDepth: number;
  floorHeight: number;
  commonAreaPerFloor: number;
  openAreaPerFloor: number;
  doorFacing: DoorFacing;
  facadeMaterial: string;
  facadeColor: string;
  /** When present, replaces the generated facade windows/entrance with explicit openings. */
  openings?: TowerOpening[];
  family?: ParametricFamilyMetadata;
  locks?: ParametricLocks;
  constraints?: ParametricConstraint[];
  phaseId?: string;
}

export type TowerOpeningKind = "window" | "door";
export type TowerOpeningFace = "north" | "south" | "east" | "west";

export interface TowerOpening {
  id: string;
  kind: TowerOpeningKind;
  face: TowerOpeningFace;
  floor: number;
  offset: number;
  width: number;
  height: number;
  sill: number;
  family?: ParametricFamilyMetadata;
}

export interface ExteriorPanel {
  id: string;
  towerId: string;
  face: "front" | "back" | "left" | "right";
  x: number;
  y: number;
  w: number;
  h: number;
  material: string;
  color: string;
}

export interface InteriorRoom {
  id: string;
  towerId: string;
  floor: number;
  name: string;
  type: string;
  x: number;
  z: number;
  w: number;
  d: number;
  doorFacing: DoorFacing;
  furniture?: FurnitureItem[];
  openings?: RoomOpening[];
  mep?: MepDesign;
  family?: ParametricFamilyMetadata;
  locks?: ParametricLocks;
  constraints?: ParametricConstraint[];
  phaseId?: string;
}

export interface SiteLocation {
  lat: number;
  lng: number;
  address?: string;
  zoom?: number;
  /** Plot boundary vertices in declaration order (WGS84). */
  boundary?: { lat: number; lng: number }[];
  /** Authored shape; legacy corner lists without this marker reopen as polygons. */
  boundaryShape?: "rectangle" | "polygon" | "corridor";
  /** Best-fit boundary width, metres. */
  boundaryWidthM?: number;
  /** Best-fit boundary depth, metres. */
  boundaryDepthM?: number;
  /** Width-axis rotation counterclockwise from east, degrees in [0, 180). */
  boundaryRotationDeg?: number;
  /** Traced route centreline (WGS84), used by linear works such as highways. */
  route?: { lat: number; lng: number }[];
  /** Measured route length, metres. */
  routeLengthM?: number;
  /** Compass bearing from north of the route's first segment or measured corridor's long axis. */
  routeBearingDeg?: number;
}

/* ------------------------- Infrastructure designs ------------------------- */

export type InfraKind = "highway" | "airport" | "ports" | "dams";

export interface InfraFacility {
  id: string;
  kind: string;
  count: number;
  lengthM: number;
  widthM: number;
  heightM: number;
  phaseId?: string;
}

export interface HighwayDesign {
  lanes: number;
  laneWidthM: number;
  medianM: number;
  shoulderM: number;
  designSpeedKph: number;
  surface: "bituminous" | "concrete";
  pavementThicknessMm: number;
  crossSlopePct: number;
  embankmentHeightM: number;
  culverts: number;
  interchanges: number;
  terrainRoughnessM: number;
}

export interface AirportDesign {
  runways: number;
  runwayLengthM: number;
  runwayWidthM: number;
  runwayHeadingDeg: number;
  taxiways: number;
  apronDepthM: number;
  terminalAreaM2: number;
  stands: number;
  aerodromeCode: "4F" | "4E" | "4C" | "3C";
  elevationM: number;
  fuelFarm: boolean;
}

export interface PortDesign {
  berths: number;
  berthLengthM: number;
  draftM: number;
  quayWidthM: number;
  breakwaterLengthM: number;
  containerYardM2: number;
  cranes: number;
  warehouses: number;
  channelDepthM: number;
  quayType: "solid" | "open-piled";
}

export interface DamDesign {
  damType: "gravity" | "earthen" | "rockfill" | "arch";
  heightM: number;
  crestLengthM: number;
  crestWidthM: number;
  upstreamSlope: number;
  downstreamSlope: number;
  freeboardM: number;
  reservoirAreaM2: number;
  spillwayType: "ogee" | "chute" | "siphon" | "morning-glory";
  spillwayCapacityCumec: number;
  spillwayGates: number;
  gateWidthM: number;
  gateHeightM: number;
  stillingBasin: boolean;
  groutCurtainDepthM: number;
}

export interface InfraDesign {
  version: 1;
  kind: InfraKind;
  /** New projects remain an empty technical site until the user generates the model. */
  modelReady?: boolean;
  facilities?: InfraFacility[];
  layers?: DesignLayer[];
  drafts?: DraftElement[];
  review?: DesignReview;
  section?: SectionSettings;
  terrain?: TerrainSettings;
  civil?: CivilSettings;
  location?: SiteLocation;
  highway?: HighwayDesign;
  airport?: AirportDesign;
  ports?: PortDesign;
  dams?: DamDesign;
  mep?: MepDesign;
}

/** Local SI corridor and rational-method drainage planning inputs. */
export interface CivilProfilePoint { stationM: number; elevationM: number; }

export interface CivilSettings {
  profile?: CivilProfilePoint[];
  showCorridor?: boolean;
  stationIntervalM: number;
  corridorWidthM: number;
  startElevationM: number;
  gradePct: number;
  crossfallPct: number;
  rainfallMmPerHour: number;
  runoffCoefficient: number;
  catchmentAreaHa: number;
}

export interface CommunityDesign {
  version: 1;
  branch: BuildingBranch;
  residentialStyle?: ResidentialStyle;
  commercialStyle?: CommercialStyle;
  land: LandSite;
  location?: SiteLocation;
  parking: Parking;
  amenities: AmenityData[];
  drafts?: DraftElement[];
  drafting?: DraftingSettings;
  layers?: DesignLayer[];
  levels?: BuildingLevel[];
  structuralGrid?: StructuralGridLine[];
  structural?: StructuralSettings;
  structuralResults?: import("./lib/structuralResults").StructuralExternalResults;
  activeLevelId?: string;
  review?: DesignReview;
  section?: SectionSettings;
  terrain?: TerrainSettings;
  towers: TowerData[];
  exteriors: ExteriorPanel[];
  interiors: InteriorRoom[];
  mep?: MepDesign;
}

export interface Design {
  version: 1;
  room: RoomConfig;
  furniture: FurnitureItem[];
  curtains: CurtainConfig | null;
  mep?: MepDesign;
  community?: CommunityDesign;
  infra?: InfraDesign;
  /** Optional Revit/Archicad-style documentation package; absent in legacy designs. */
  documentation?: DocumentationMetadata;
  compliance?: { profileId: string };
  /** Authored project country, adopted editions and user criteria; absent in legacy projects. */
  engineeringBasis?: EngineeringDesignBasis;
  technicalGraphics?: TechnicalGraphicsSettings;
  visualization?: VisualizationSettings;
  /** Architectural CAD objects for room projects. Community/infra projects retain their existing drafts arrays. */
  drafts?: DraftElement[];
  /** Additive CAD metadata. Geometry remains in the existing drafts and MEP records. */
  cad?: CadWorkspaceState;
  /** Explicit connector, circuit and system topology; legacy MEP geometry stays in MepDesign. */
  cadNetworks?: import("./lib/cadNetworks").CadNetworkState;
}

export interface CadAnalysisRecord {
  id: string;
  sourceObjectIds: string[];
  sourceRevision: number;
  status: "current" | "needs-recalculation" | "incomplete" | "unsupported";
  method: string;
  units: string;
  inputs: Record<string, unknown>;
  assumptions: string[];
  designBasis: string;
  result?: Record<string, unknown>;
}

export interface CadWorkspaceState {
  version: 1;
  revision: number;
  levels?: BuildingLevel[];
  displayUnits?: "m" | "mm" | "ft";
  analyses?: CadAnalysisRecord[];
}

/* AI plans are proposals only. Applying them remains a client/editor decision. */
export type AssistantAction =
  | { type: "set_plot_dimensions"; width: number; depth: number; unit: UnitSystem }
  | { type: "add_tower"; label: string; x: number; z: number; floors?: number; unitsPerFloor?: number }
  | { type: "remove_tower"; towerId: string }
  | { type: "update_tower"; towerId: string; patch: Partial<Pick<TowerData, "label" | "x" | "z" | "rotY" | "floors" | "unitsPerFloor" | "unitWidth" | "unitDepth" | "floorHeight">> }
  | { type: "add_amenity"; kind: string; x: number; z: number; w?: number; d?: number; h?: number }
  | { type: "remove_amenity"; amenityId: string }
  | { type: "update_amenity"; amenityId: string; patch: Partial<Pick<AmenityData, "x" | "z" | "rotY" | "w" | "d" | "h">> }
  | { type: "add_drafting_element"; kind: DraftElementKind; x: number; z: number; w: number; d: number; h?: number; rotationDeg: number; color: string; label?: string }
  | { type: "update_room_opening"; roomId: string; openingId?: string; roomPatch?: Partial<Pick<InteriorRoom, "floor" | "name" | "type" | "x" | "z" | "w" | "d">>; openingPatch?: Partial<Pick<RoomOpening, "kind" | "wall" | "offsetM" | "widthM" | "heightM" | "sillM">> }
  | { type: "add_room_opening"; roomId: string; kind: RoomOpening["kind"]; wall: RoomOpening["wall"]; offsetM: number; widthM: number; heightM: number; sillM: number }
  | { type: "add_room_furniture"; roomId: string; catalogId: string; name?: string; x: number; z: number; rotationDeg?: number; scale?: number; color?: string; mount?: FurnitureMount; mountWall?: RoomWall }
  | { type: "update_room_furniture"; roomId: string; furnitureId: string; patch: Partial<Pick<FurnitureItem, "name" | "x" | "z" | "rotationDeg" | "scale" | "color" | "mount" | "mountWall" | "mountHeightM">> }
  | { type: "add_mep_element"; kind: MepElementKind; name: string; route: MepPoint[]; width: number; height: number; diameter: number; ratedPowerKw?: number; levelId?: string }
  | { type: "update_infrastructure"; parameters: { lanes?: number; laneWidthM?: number; designSpeedKph?: number; runways?: number; runwayLengthM?: number; berths?: number; damType?: DamDesign["damType"]; heightM?: number; facilities?: InfraFacility[]; facilityPatches?: { facilityId: string; patch: Partial<Pick<InfraFacility, "kind" | "count" | "lengthM" | "widthM" | "heightM">> }[] } }
  | { type: "generate_infrastructure_model" }
  | { type: "request_analysis"; scope: "structural" | "mep" | "infrastructure" | "site" | "general"; questions: string[] };

export interface AssistantPlan {
  summary: string;
  actions: AssistantAction[];
  warnings: string[];
}

export interface AssistantPlanResponse {
  source: "ai" | "offline";
  model: string | null;
  assistantMessage: string;
  plan: AssistantPlan;
}

export function defaultDesign(): Design {
  return {
    version: 1,
    room: {
      widthMm: 6000,
      depthMm: 4000,
      wallHeightMm: 2700,
      wallColor: "#e8e2d0",
      floorColor: "#b59a7f",
    },
    furniture: [],
    curtains: null,
    mep: { version: 1, enabled: true, elements: [] },
  };
}

