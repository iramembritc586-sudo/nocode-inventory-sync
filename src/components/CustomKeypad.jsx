import React from 'react';
import { Button } from '@/components/ui/button';

const CustomKeypad = ({ onKeyPress, onConfirm, onDelete, confirmText = "确认" }) => {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'];

  const handleKeyDown = (key) => {
    // 触发震动反馈
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
    onKeyPress(key);
  };

  return (
    <div className="grid grid-cols-3 gap-2 p-4 bg-gray-100 rounded-lg">
      {keys.map((key) => (
        <Button
          key={key}
          onClick={() => handleKeyDown(key)}
          className="h-12 text-lg font-bold transition-all duration-100 active:scale-95 active:bg-blue-300"
          variant="outline"
        >
          {key}
        </Button>
      ))}
      <Button
        onClick={onDelete}
        className="h-12 text-lg font-bold bg-red-500 text-white hover:bg-red-600"
      >
        删除
      </Button>
      <Button
        onClick={onConfirm}
        className="col-span-2 h-12 text-lg font-bold"
      >
        {confirmText}
      </Button>
    </div>
  );
};

export default CustomKeypad;
