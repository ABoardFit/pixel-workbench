import { Eye, EyeOff, Layers2, Plus, Trash2 } from 'lucide-react';
import type { EditorBoard, Silhouette, SpriteAsset } from '../types';
import { measureOverlap } from '../lib/pixels';
import { IconButton, NumberField } from './UI';

interface Props {
  board?: EditorBoard; asset?: SpriteAsset; captured: Silhouette | null; color: string;
  onColor: (color: string) => void; onCapture: () => void; onPaste: () => void;
  onSelect: (id: string) => void; onChange: (id: string, patch: Partial<Silhouette>) => void; onDelete: (id: string) => void;
  onDuration: (duration: number) => void; onRepeat: (repeat: number) => void;
}
export default function Inspector({ board, asset, captured, color, onColor, onCapture, onPaste, onSelect, onChange, onDelete, onDuration, onRepeat }: Props) {
  const selected = board?.overlays.find(layer => layer.id === board.selectedOverlayId);
  const frame = asset && board ? asset.frames[board.frameIndex] : undefined;
  const overlap = selected && frame && asset ? measureOverlap(frame.pixels, asset.width, asset.height, selected) : null;
  return <>
    <div className="panel-heading"><h2>실루엣</h2><span className="count-pill">{board?.overlays.length ?? 0}</span></div>
    <section className="inspector-section capture-section">
      <p className="panel-description">한 프레임을 단색으로 잡아<br />다른 칸 위에 겹쳐 보세요.</p>
      <div className="silhouette-capture-row"><label className="capture-color" title="실루엣 색"><input aria-label="새 실루엣 색" type="color" value={color} onChange={event => onColor(event.target.value)} /></label><button type="button" className="secondary-button" onClick={onCapture} disabled={!board}><Layers2 size={15} />현재 프레임 잡기</button></div>
      {captured && <div className="captured-source"><span className="swatch-dot" style={{ background: captured.color }} /><span title={captured.name}>{captured.name}</span><span>보관 중</span></div>}
      <button type="button" className="paste-overlay-button" onClick={onPaste} disabled={!captured || !board}><Plus size={15} />이 칸에 실루엣 추가</button>
      <p className="micro-help">잡은 뒤 원하는 비교 칸을 선택해 추가하세요.</p>
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
      {overlap && <div className="overlap-readout"><span>모양 겹침</span><strong>{overlap.percent.toFixed(1)}<small>%</small></strong><div className="overlap-track"><i style={{ width: `${overlap.percent}%` }} /></div><p>두 모양을 합친 영역 중 겹치는 비율</p></div>}
      <p className="micro-help">이동 도구 <kbd>O</kbd> 또는 <kbd>Alt</kbd>를 누른 채 드래그</p>
    </section>}
    {asset && frame && <section className="inspector-section frame-properties"><h3>프레임 정보</h3><NumberField label="시간 (ms)" value={frame.durationMs} min={0} max={60000} step={10} onChange={onDuration} /><label className="stacked-label">반복<select aria-label="애니메이션 반복 방식" value={asset.repeat === -1 ? 'once' : asset.repeat === 0 ? 'forever' : 'count'} onChange={event => onRepeat(event.target.value === 'once' ? -1 : event.target.value === 'forever' ? 0 : 1)}><option value="forever">무한 반복</option><option value="once">한 번 재생</option><option value="count">반복 횟수 지정</option></select></label>{asset.repeat > 0 && <NumberField label="반복 횟수" value={asset.repeat} min={1} max={65535} onChange={value => onRepeat(Math.round(value))} />}<p className="micro-help">칸의 재생 속도는 내보내기에 영향을 주지 않아요.</p></section>}
    <div className="sidebar-bottom-note">실루엣은 비교용 레이어입니다.<br />내보내기에 포함할지 따로 선택할 수 있어요.</div>
  </>;
}
