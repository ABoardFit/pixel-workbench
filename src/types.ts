export type RGBA = [number, number, number, number];
export interface Point { x: number; y: number }
export type Tool = 'pan' | 'pencil' | 'line' | 'eraser' | 'picker' | 'fill' | 'overlay';
export interface PixelFrame {
  id: string;
  pixels: Uint8ClampedArray;
  durationMs: number;
}
export interface SpriteAsset {
  id: string;
  name: string;
  width: number;
  height: number;
  frames: PixelFrame[];
  repeat: number;
}
export interface Silhouette {
  id: string;
  name: string;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  color: string;
  opacity: number;
  x: number;
  y: number;
  scale: number;
  order: 'front' | 'back';
  visible: boolean;
}
export interface EditorBoard {
  id: string;
  assetId: string;
  frameIndex: number;
  playing: boolean;
  speed: number;
  zoom: number;
  panX: number;
  panY: number;
  overlays: Silhouette[];
  selectedOverlayId: string | null;
}
export interface WorkspaceProject {
  version: 1;
  assets: SpriteAsset[];
  boards: EditorBoard[];
  activeBoardId: string | null;
}
