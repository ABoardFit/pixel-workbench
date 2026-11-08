import { Eye, EyeOff, FlipHorizontal2, Layers2, Plus, Trash2 } from 'lucide-react';
import type { EditorBoard, RulerGuide, Silhouette, SpriteAsset } from '../types';
import { measureOverlap } from '../lib/pixels';
import { IconButton, NumberField, PixelPreview } from './UI';

interface Props {
  guides: RulerGuide[]; onGuideChange: (id: string, patch: Partial<RulerGuide>) => void; onGuideDelete: (id: string) => void; onGuideClear: () => void;
  board?: EditorBoard; asset?: SpriteAsset; captured: Silhouette | null; color: string;
  boardNumber: number; onFlip: (id: string) => void;
  onColor: (color: string) => void; onCapture: () => void; onPaste: () => void;
  onSelect: (id: string) => void; onChange: (id: string, patch: Partial<Silhouette>) => void; onDelete: (id: string) => void;
  onDuration: (duration: number) => void; onRepeat: (repeat: number) => void;
}
export default function Inspector({ guides, onGuideChange, onGuideDelete, onGuideClear, board, asset, captured, color, boardNumber, onFlip, onColor, onCapture, onPaste, onSelect, onChange, onDelete, onDuration, onRepeat }: Props) {
  const selected = board?.overlays.find(layer => layer.id === board.selectedOverlayId);
  const frame = asset && board ? asset.frames[board.frameIndex] : undefined;
  const overlap = selected && frame && asset ? measureOverlap(frame.pixels, asset.width, asset.height, selected) : null;
  return <>
    <div className="panel-heading"><h2>실루엣</h2><span className="count-pill">{board?.overlays.length ?? 0}</span></div>
    <section className="inspector-section capture-section">
      <p className="aid-only-note">화면 비교용 · 이미지에는 저장되지 않음</p>
      <h3 className="silhouette-step"><span>1</span>기준 프레임 잡기</h3>
      <p className="micro-help">기준으로 삼을 그림이나 칸 이름을 먼저 누르세요.</p>
      {frame && asset && board ? <div className="silhouette-frame-summary"><span className="silhouette-frame-thumb checker-light"><PixelPreview pixels={frame.pixels} width={asset.width} height={asset.height} /></span><div><strong>{boardNumber}번 칸 · {board.frameIndex + 1}프레임</strong><small title={asset.name}>{asset.name}</small></div></div> : <p className="micro-help">이미지를 열고 기준 칸을 선택하세요.</p>}
      <div className="silhouette-capture-row"><label className="capture-color" title="실루엣 색"><input aria-label="새 실루엣 색" type="color" value={color} onChange={event => onColor(event.target.value)} /></label><button type="button" className="secondary-button" onClick={onCapture} disabled={!board}><Layers2 size={15} />현재 프레임 잡기</button></div>
      {captured && <div className="silhouette-frame-summary captured-reference" aria-label="잡아 둔 실루엣 기준"><span className="silhouette-frame-thumb checker-light"><PixelPreview pixels={captured.pixels} width={captured.width} height={captured.height} /></span><div><strong>잡아 둔 기준</strong><small title={captured.name}>{captured.name}</small></div></div>}
      <h3 className="silhouette-step target-step"><span>2</span>겹칠 대상 선택</h3>
      <p className="micro-help">다른 그림이나 칸 이름을 누르면 대상이 바뀝니다.</p>
      {board && asset && frame && <div className="silhouette-frame-summary silhouette-target" aria-label="실루엣 대상 칸"><span className="silhouette-frame-thumb checker-light"><PixelPreview pixels={frame.pixels} width={asset.width} height={asset.height} /></span><div><strong>{boardNumber}번 칸 · {board.frameIndex + 1}프레임에 겹치기</strong><small title={asset.name}>{asset.name}</small></div></div>}
      <button type="button" className="paste-overlay-button" onClick={onPaste} disabled={!captured || !board}><Plus size={15} />이 칸에 실루엣 추가</button>
      <p className="micro-help">기준을 잡은 뒤 원하는 대상 칸에 추가하세요.</p>
    </section>
    <div className="layer-list" aria-label="실루엣 레이어 목록">
      {!board?.overlays.length && <div className="no-layers"><Layers2 size={23} /><span>겹친 실루엣이 없어요</span></div>}
      {board?.overlays.map((layer, index) => <div key={layer.id} className={`layer-row ${selected?.id === layer.id ? 'selected' : ''}`}>
        <IconButton label={layer.visible ? `${index + 1}번 실루엣 숨기기` : `${index + 1}번 실루엣 보이기`} onClick={() => onChange(layer.id, { visible: !layer.visible })}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</IconButton>
        <button type="button" className="layer-select" aria-pressed={selected?.id === layer.id} onClick={() => onSelect(layer.id)}><span className="layer-color" style={{ background: layer.color }} /><span><strong>{layer.name}</strong><small>{layer.order === 'front' ? '캐릭터 앞' : '캐릭터 뒤'} · {Math.round(layer.opacity * 100)}%</small></span></button>
        <IconButton label={`${index + 1}번 실루엣 삭제`} onClick={() => onDelete(layer.id)}><Trash2 size={14} /></IconButton>
      </div>)}
    </div>
    {selected && <section className="inspector-section layer-properties">
      <div className="section-heading"><h3>겹치기 설정</h3><input aria-label="선택한 실루엣 색" type="color" value={selected.color} onChange={event => onChange(selected.id, { color: event.target.value })} /></div>
      <label className="range-field"><span>불투명도<strong>{Math.round(selected.opacity * 100)}%</strong></span><input aria-label="실루엣 불투명도" type="range" min={0} max={100} value={Math.round(selected.opacity * 100)} onChange={event => onChange(selected.id, { opacity: Number(event.target.value) / 100 })} /></label>
      <label className="stacked-label">쌓는 순서<select aria-label="실루엣 앞뒤 순서" value={selected.order} onChange={event => onChange(selected.id, { order: event.target.value as 'front' | 'back' })}><option value="front">캐릭터 앞</option><option value="back">캐릭터 뒤</option></select></label>
      <div className="field-pair"><NumberField label="실루엣 X" value={selected.x} min={-8192} max={8192} onChange={value => onChange(selected.id, { x: Math.round(value) })} /><NumberField label="실루엣 Y" value={selected.y} min={-8192} max={8192} onChange={value => onChange(selected.id, { y: Math.round(value) })} /></div>
      <NumberField label="실루엣 배율" value={selected.scale} min={0.05} max={8} step={0.05} onChange={value => onChange(selected.id, { scale: value })} />
      <div className="inline-actions"><button type="button" onClick={() => asset && onChange(selected.id, { x: Math.round((asset.width - selected.width * selected.scale) / 2), y: Math.round((asset.height - selected.height * selected.scale) / 2) })}>가운데 맞춤</button><button type="button" onClick={() => onChange(selected.id, { x: 0, y: 0, scale: 1 })}>원래 크기</button></div>
      <button type="button" className="silhouette-flip-button" onClick={() => onFlip(selected.id)}><FlipHorizontal2 size={14} />선택한 실루엣 좌우반전</button>
      {overlap && <div className="overlap-readout"><span>모양 겹침</span><strong>{overlap.percent.toFixed(1)}<small>%</small></strong><div className="overlap-track"><i style={{ width: `${overlap.percent}%` }} /></div><p>두 모양을 합친 영역 중 겹치는 비율</p></div>}
      <p className="micro-help">이동 도구 <kbd>O</kbd> 또는 <kbd>Alt</kbd>를 누른 채 드래그</p>
    </section>}
    <section className="inspector-section ruler-properties"><div className="section-heading"><h3>룰러(자) <span className="count-pill">{guides.length}</span></h3><button type="button" className="clear-guides-button" aria-label="모든 자 지우기" disabled={!guides.length} onClick={onGuideClear}>모두 지우기</button></div><p className="aid-only-note">화면 비교용 · 이미지에는 저장되지 않음</p>{!guides.length && <p className="micro-help"><kbd>R</kbd>을 누르고 캔버스 위에 그으세요.<br />도트선과 달리 픽셀을 바꾸지 않습니다.</p>}<div className="guide-list" aria-label="룰러 가이드 목록">{guides.map((guide, index) => <div className={`guide-row ${guide.visible ? '' : 'hidden'}`} key={guide.id}><IconButton label={guide.visible ? `${index + 1}번 자 숨기기` : `${index + 1}번 자 보이기`} onClick={() => onGuideChange(guide.id, { visible: !guide.visible })}>{guide.visible ? <Eye size={14} /> : <EyeOff size={14} />}</IconButton><span className="guide-color" style={{ background: guide.color }} /><div><strong>자 {index + 1}</strong><small>{guide.x1}, {guide.y1} → {guide.x2}, {guide.y2}</small></div><IconButton label={`${index + 1}번 자 삭제`} onClick={() => onGuideDelete(guide.id)}><Trash2 size={13} /></IconButton></div>)}</div></section>
    {asset && frame && <section className="inspector-section frame-properties"><h3>프레임 정보</h3><NumberField label="시간 (ms)" value={frame.durationMs} min={0} max={60000} step={10} onChange={onDuration} /><label className="stacked-label">반복<select aria-label="애니메이션 반복 방식" value={asset.repeat === -1 ? 'once' : asset.repeat === 0 ? 'forever' : 'count'} onChange={event => onRepeat(event.target.value === 'once' ? -1 : event.target.value === 'forever' ? 0 : 1)}><option value="forever">무한 반복</option><option value="once">한 번 재생</option><option value="count">반복 횟수 지정</option></select></label>{asset.repeat > 0 && <NumberField label="반복 횟수" value={asset.repeat} min={1} max={65535} onChange={value => onRepeat(Math.round(value))} />}<p className="micro-help">칸의 재생 속도는 내보내기에 영향을 주지 않아요.</p></section>}
    <div className="sidebar-bottom-note">편집 상태 저장으로 비교 설정을 보관하고,<br />이미지 저장으로 그림만 내려받으세요.</div>
  </>;
}
