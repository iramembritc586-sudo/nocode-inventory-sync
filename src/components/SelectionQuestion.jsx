import React from 'react';
import { Button } from '@/components/ui/button';

const TRANSITION_GUARD_MS = 220;
const TOUCH_SUBMIT_DELAY_MS = 80;
const GHOST_CLICK_WINDOW_MS = 450;

let globalSuppressClickUntil = 0;

const colorMap = {
  '蓝色': 'bg-blue-500',
  '透明': 'bg-gray-200',
  '红色': 'bg-red-500',
  '绿色': 'bg-green-500',
  '粉红色': 'bg-pink-500'
};

const SelectionQuestion = ({ options, onSelect, selectedValue, questionKey }) => {
  const [isTransitionGuardActive, setIsTransitionGuardActive] = React.useState(true);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const submitTimerRef = React.useRef(null);
  const supportsPointerEvent = typeof window !== 'undefined' && 'PointerEvent' in window;

  React.useEffect(() => {
    setIsTransitionGuardActive(true);
    setIsSubmitting(false);

    if (submitTimerRef.current) {
      window.clearTimeout(submitTimerRef.current);
      submitTimerRef.current = null;
    }

    const timer = window.setTimeout(() => {
      setIsTransitionGuardActive(false);
    }, TRANSITION_GUARD_MS);

    return () => {
      window.clearTimeout(timer);
      if (submitTimerRef.current) {
        window.clearTimeout(submitTimerRef.current);
        submitTimerRef.current = null;
      }
    };
  }, [questionKey]);

  const commitSelection = React.useCallback((event, option, pointerType = 'mouse') => {
    if (isTransitionGuardActive || isSubmitting) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget?.blur) {
      event.currentTarget.blur();
    }

    if (navigator.vibrate) {
      navigator.vibrate(20);
    }

    setIsSubmitting(true);
    globalSuppressClickUntil = Date.now() + GHOST_CLICK_WINDOW_MS;

    const isTouchInput = pointerType === 'touch' || pointerType === 'pen';
    const delay = isTouchInput ? TOUCH_SUBMIT_DELAY_MS : 0;

    submitTimerRef.current = window.setTimeout(() => {
      onSelect(option);
    }, delay);
  }, [isSubmitting, isTransitionGuardActive, onSelect]);

  const isLocked = isTransitionGuardActive || isSubmitting;

  return (
    <div className={`grid grid-cols-2 gap-3 p-4 ${isLocked ? 'pointer-events-none' : ''}`}>
      {options.map((option) => (
        <Button
          key={`${questionKey ?? 'question'}-${option}`}
          type="button"
          onPointerUp={(event) => {
            commitSelection(event, option, event.pointerType || 'mouse');
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();

            // pointerup 后浏览器可能补发 click，这里统一吞掉。
            if (Date.now() < globalSuppressClickUntil) {
              return;
            }

            // 兜底：老设备不支持 PointerEvent 时，允许 click 提交一次。
            if (!supportsPointerEvent) {
              const pointerType = (window.navigator?.maxTouchPoints || 0) > 0 ? 'touch' : 'mouse';
              commitSelection(event, option, pointerType);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              commitSelection(event, option, 'mouse');
            }
          }}
          className={`h-16 touch-manipulation select-none text-lg font-medium transition-all duration-100 active:scale-95 ${
            selectedValue === option
              ? 'bg-gray-800 text-white active:bg-gray-900'
              : colorMap[option] || 'bg-white text-gray-800 active:bg-gray-100'
          }`}
          variant="outline"
          disabled={isLocked}
        >
          {option}
          {selectedValue === option && (
            <span className="ml-2 rounded-full bg-white px-2 py-1 text-xs text-gray-800">
              已选择
            </span>
          )}
        </Button>
      ))}
    </div>
  );
};

export default SelectionQuestion;