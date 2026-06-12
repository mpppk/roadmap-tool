import { fmt, fmt2 } from "@/shared/utils/capacity-format";

export type CapacityConflictResolution =
  | "fitWithinLimit"
  | "allowOverflow"
  | "rebalanceOthersProportionally"
  | "rebalanceAllProportionally";

export type RebalancePreview = {
  featureName: string;
  currentCapacity: number;
  nextCapacity: number;
};

export function MaxCapacityOverflowPopover({
  memberName,
  limit,
  requestedCapacity,
  usedElsewhere,
  onResolve,
  onCancel,
  displayDivisor = 1,
}: {
  memberName: string;
  limit: number;
  requestedCapacity: number;
  usedElsewhere: number;
  onResolve: (resolution: "fitWithinLimit" | "allowOverflow") => void;
  onCancel: () => void;
  displayDivisor?: number;
}) {
  const d = displayDivisor;
  const reducedValue = Math.max(0, limit - usedElsewhere);

  return (
    <div className="capacity-conflict-popover" role="dialog" aria-modal="false">
      <div className="capacity-conflict-lines">
        <div>
          {memberName}のmax capacity ({fmt2(limit / d)}) を超えています。
        </div>
        <div>今回の割り当てキャパシティ: {fmt2(requestedCapacity / d)}</div>
      </div>
      <div className="capacity-conflict-actions">
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("fitWithinLimit")}
        >
          {`縮小して設定 (${fmt2(reducedValue / d)})`}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("allowOverflow")}
        >
          {`max capacityを超えて設定 (${fmt2(requestedCapacity / d)})`}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

export function CapacityConflictPopover({
  memberName,
  usedElsewhere,
  assignableCapacity,
  requestedCapacity,
  rebalancePreview,
  rebalanceAllPreview,
  onResolve,
  onCancel,
  displayDivisor = 1,
}: {
  memberName: string;
  usedElsewhere: number;
  assignableCapacity: number;
  requestedCapacity: number;
  rebalancePreview: RebalancePreview[];
  rebalanceAllPreview: {
    newCapacity: number;
    othersPreview: RebalancePreview[];
  };
  onResolve: (resolution: CapacityConflictResolution) => void;
  onCancel: () => void;
  displayDivisor?: number;
}) {
  const d = displayDivisor;
  const overflowTotal = usedElsewhere + requestedCapacity;

  return (
    <div className="capacity-conflict-popover" role="dialog" aria-modal="false">
      <div className="capacity-conflict-lines">
        <div>{memberName}の合計キャパシティが1を超えています。</div>
        <div>割り当て済み: {fmt2(usedElsewhere / d)}</div>
        <div>残りキャパシティ: {fmt2(assignableCapacity / d)}</div>
        <div>今回の割り当てキャパシティ: {fmt2(requestedCapacity / d)}</div>
      </div>
      <div className="capacity-conflict-actions">
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("allowOverflow")}
        >
          {`そのまま割り当て(${fmt2(usedElsewhere / d)}+${fmt2(
            requestedCapacity / d,
          )}=${fmt2(overflowTotal / d)})`}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("fitWithinLimit")}
        >
          超過しない最大値({fmt2(assignableCapacity / d)})を割り当て
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("rebalanceOthersProportionally")}
        >
          <span>超過しないように他Epicのキャパシティを削減</span>
          {rebalancePreview.length > 0 && (
            <span className="capacity-conflict-preview-list">
              {rebalancePreview.map((change) => (
                <span
                  key={change.featureName}
                  className="capacity-conflict-preview-item"
                >
                  {change.featureName}: {fmt(change.currentCapacity / d)}→
                  {fmt(change.nextCapacity / d)}
                </span>
              ))}
            </span>
          )}
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={() => onResolve("rebalanceAllProportionally")}
        >
          <span>比率を保ったままmax capacityに収まるように縮小</span>
          <span className="capacity-conflict-preview-list">
            <span className="capacity-conflict-preview-item">
              今回: {fmt(requestedCapacity / d)}→
              {fmt(rebalanceAllPreview.newCapacity / d)}
            </span>
            {rebalanceAllPreview.othersPreview.map((change) => (
              <span
                key={change.featureName}
                className="capacity-conflict-preview-item"
              >
                {change.featureName}: {fmt(change.currentCapacity / d)}→
                {fmt(change.nextCapacity / d)}
              </span>
            ))}
          </span>
        </button>
        <button
          type="button"
          className="btn-sm capacity-conflict-action-btn"
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}
