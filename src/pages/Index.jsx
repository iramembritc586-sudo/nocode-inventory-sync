import * as XLSX from 'xlsx';
import SelectionQuestion from '@/components/SelectionQuestion';
import React, { useEffect, useState } from 'react';
import CustomKeypad from '@/components/CustomKeypad';
import { Button } from '@/components/ui/button';
import { Inventory } from '@/integrations/backend/entities';
import {
  INVENTORY_FIELD_LABELS,
  columnNameFromIndex,
  createInventoryImport,
  rebuildInventoryImport,
  exportInventoryWorkbook,
  makeInventoryFileName
} from '@/lib/inventoryTools';

const MOBILE_UA_REGEX = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone/i;
const LOCAL_SYNC_API_PATH = '/__local_sync__/inventory';
const USE_LOCAL_SYNC_IN_DEV = import.meta.env.DEV || import.meta.env.VITE_USE_LOCAL_SYNC === 'true';
const SELECTION_EVENT_LOCK_MS = 380;
const LOCAL_NETWORK_INFO_API_PATH = '/__local_sync__/network';

const isLoopbackHost = (hostname = '') => {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
};

const isMobileClientDevice = () => {
  if (typeof window === 'undefined') return false;
  const userAgent = window.navigator?.userAgent || '';
  const isTouchDevice = (window.navigator?.maxTouchPoints || 0) > 0;
  const isNarrowScreen = window.matchMedia
    ? window.matchMedia('(max-width: 768px)').matches
    : window.innerWidth <= 768;

  return MOBILE_UA_REGEX.test(userAgent) || (isTouchDevice && isNarrowScreen);
};

export default function Index() {
  // 当前题目索引
  const [currentQuestion, setCurrentQuestion] = useState(1);
  // 所有题目答案
  const [answers, setAnswers] = useState({});
  // 原材料规格数据数组
  const [rawMaterialSpecs, setRawMaterialSpecs] = useState([]);
  // 成品尾数数组
  const [remainders, setRemainders] = useState([]);
  // 当前输入值
  const [currentInput, setCurrentInput] = useState('');
  // 闪烁效果状态
  const [flash, setFlash] = useState(false);
  // 当前序号（用于跟踪新规格）
  const [currentSequence, setCurrentSequence] = useState(1);
  const [shouldExport, setShouldExport] = useState(false);
  // 添加新的状态来存储编码与产品名称的映射
  const [productNames, setProductNames] = useState({});
  // 添加Excel数据状态
  const [excelData, setExcelData] = useState([]);
  // 添加文件上传状态
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  // 源数据导入整理状态
  const [sourceInventoryImport, setSourceInventoryImport] = useState(null);
  const [sourceInventoryError, setSourceInventoryError] = useState('');
  const [isSourceInventoryUploading, setIsSourceInventoryUploading] = useState(false);
  // 手机/PC 实时同步状态：同一个“同步批次号”的设备会互相同步已保存数据
  const [syncBatch, setSyncBatch] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const batchFromUrl = params.get('batch');
      const batchFromStorage = localStorage.getItem('inventory_sync_batch');
      const today = new Date();
      const defaultBatch = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      return batchFromUrl || batchFromStorage || defaultBatch;
    } catch (error) {
      return 'default';
    }
  });
  const [syncStatus, setSyncStatus] = useState('等待同步');
  const [syncError, setSyncError] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [cloudRecordCount, setCloudRecordCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showSyncedList, setShowSyncedList] = useState(false);
  const [sessionSpecs, setSessionSpecs] = useState([]);
  const [listExportScope, setListExportScope] = useState('session');
  const [selectedRecordKeys, setSelectedRecordKeys] = useState([]);
  const [isMobileClient, setIsMobileClient] = useState(() => isMobileClientDevice());
  const [shareableSyncUrl, setShareableSyncUrl] = useState('');
  const selectionEventLockUntilRef = React.useRef(0);

  const getLocalDeviceId = () => {
    try {
      const storageKey = 'inventory_device_id';
      let deviceId = localStorage.getItem(storageKey);
      if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(storageKey, deviceId);
      }
      return deviceId;
    } catch (error) {
      return 'unknown_device';
    }
  };

  const normalizeKeyValue = (value) => {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    if (!text) return '';
    const numericValue = Number(text);
    if (Number.isFinite(numericValue)) return String(numericValue);
    return text;
  };

  const makeSpecRecordKey = (spec = {}, batch = syncBatch) => {
    if (spec.productType === '成品') {
      return [
        batch,
        '成品',
        normalizeKeyValue(spec.productCode),
        normalizeKeyValue(spec.quantityPerRoll),
        normalizeKeyValue(spec.totalRolls),
        normalizeKeyValue(spec.remainders)
      ].join('|');
    }

    return [
      batch,
      spec.productType === '原材料' ? '半成品' : (spec.productType || '半成品'),
      normalizeKeyValue(spec.sequenceNumber),
      normalizeKeyValue(spec.thickness),
      normalizeKeyValue(spec.color),
      normalizeKeyValue(spec.resistance),
      normalizeKeyValue(spec.weightMin),
      normalizeKeyValue(spec.weightMax),
      normalizeKeyValue(spec.width),
      normalizeKeyValue(spec.length),
      normalizeKeyValue(spec.rollCount)
    ].join('|');
  };

  const toNumberIfPossible = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return value;
    const numericValue = Number(String(value).trim());
    return Number.isFinite(numericValue) ? numericValue : value;
  };

  const normalizeSpecForCloud = (spec = {}) => {
    const normalized = {
      ...spec,
      sequenceNumber: toNumberIfPossible(spec.sequenceNumber),
      thickness: toNumberIfPossible(spec.thickness),
      weightMin: toNumberIfPossible(spec.weightMin),
      weightMax: toNumberIfPossible(spec.weightMax),
      width: toNumberIfPossible(spec.width),
      length: toNumberIfPossible(spec.length),
      rollCount: toNumberIfPossible(spec.rollCount),
      quantityPerRoll: toNumberIfPossible(spec.quantityPerRoll),
      totalRolls: toNumberIfPossible(spec.totalRolls),
      syncBatch,
      recordKey: makeSpecRecordKey(spec),
      deviceId: getLocalDeviceId(),
      updatedAt: new Date().toISOString()
    };

    if (!normalized.createdAt) {
      normalized.createdAt = normalized.updatedAt;
    }

    return normalized;
  };

  const extractRowsFromBackendResponse = (response) => {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(response?.items)) return response.items;
    return [];
  };

  const fetchLocalInventoryRows = async (batch = syncBatch) => {
    const response = await fetch(`${LOCAL_SYNC_API_PATH}?batch=${encodeURIComponent(batch)}`);
    if (!response.ok) {
      throw new Error(`本地同步读取失败（${response.status}）`);
    }
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.filter((item) => item?.productType);
  };

  const saveLocalInventoryRow = async (spec, batch = syncBatch) => {
    const response = await fetch(LOCAL_SYNC_API_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch, item: spec })
    });

    if (!response.ok) {
      throw new Error(`本地同步写入失败（${response.status}）`);
    }

    return response.json();
  };

  const mergeInventoryRecords = (localRows = [], remoteRows = []) => {
    const map = new Map();
    [...localRows, ...remoteRows].forEach((item) => {
      if (!item || !item.productType) return;
      const key = item.recordKey || makeSpecRecordKey(item, item.syncBatch || syncBatch);
      map.set(key, item);
    });

    return Array.from(map.values()).sort((a, b) => {
      const aSeq = Number(a.sequenceNumber ?? 0);
      const bSeq = Number(b.sequenceNumber ?? 0);
      if (Number.isFinite(aSeq) && Number.isFinite(bSeq) && aSeq !== bSeq) return aSeq - bSeq;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  };

  const fetchCloudInventoryRows = async (batch = syncBatch) => {
    if (USE_LOCAL_SYNC_IN_DEV) {
      return fetchLocalInventoryRows(batch);
    }

    try {
      const response = await Inventory.filter({ where: { syncBatch: batch } });
      return extractRowsFromBackendResponse(response).filter((item) => item.productType);
    } catch (error) {
      console.warn('按同步批次读取云端数据失败，尝试读取全部数据后本地过滤:', error);
      const response = await Inventory.filter({});
      return extractRowsFromBackendResponse(response)
        .filter((item) => item.productType)
        .filter((item) => !item.syncBatch || item.syncBatch === batch);
    }
  };

  const loadCloudInventory = async ({ replaceLocal = false, silent = false } = {}) => {
    if (!syncBatch) return [];
    try {
      if (!silent) setIsSyncing(true);
      const cloudRows = await fetchCloudInventoryRows(syncBatch);
      setCloudRecordCount(cloudRows.length);
      setRawMaterialSpecs((prev) => mergeInventoryRecords(replaceLocal ? [] : prev, cloudRows));
      setSessionSpecs((prev) => mergeInventoryRecords(prev, cloudRows));
      setLastSyncedAt(new Date().toLocaleTimeString());
      if (USE_LOCAL_SYNC_IN_DEV) {
        setSyncStatus(`已本地同步 ${cloudRows.length} 条`);
      } else {
        setSyncStatus(`已同步 ${cloudRows.length} 条`);
      }
      setSyncError('');
      return cloudRows;
    } catch (error) {
      console.error(USE_LOCAL_SYNC_IN_DEV ? '本地同步数据失败:' : '同步云端数据失败:', error);
      setSyncError(USE_LOCAL_SYNC_IN_DEV ? '本地同步失败：请检查开发服务是否正常' : '同步失败：请检查网络或后端配置');
      return [];
    } finally {
      if (!silent) setIsSyncing(false);
    }
  };

  const syncSpecToCloud = async (spec) => {
    if (!spec || !spec.productType || !syncBatch) return;
    try {
      setSyncStatus('正在同步...');
      const cloudSpec = normalizeSpecForCloud(spec);
      const cloudRows = await fetchCloudInventoryRows(syncBatch);
      const alreadyExists = cloudRows.some((row) => {
        const rowKey = row.recordKey || makeSpecRecordKey(row, row.syncBatch || syncBatch);
        return rowKey === cloudSpec.recordKey;
      });

      if (!alreadyExists && USE_LOCAL_SYNC_IN_DEV) {
        await saveLocalInventoryRow(cloudSpec, syncBatch);
      } else if (!alreadyExists) {
        await Inventory.create(cloudSpec);
      }

      setCloudRecordCount(alreadyExists ? cloudRows.length : cloudRows.length + 1);
      setLastSyncedAt(new Date().toLocaleTimeString());
      if (USE_LOCAL_SYNC_IN_DEV) {
        setSyncStatus(alreadyExists ? '本地已存在该条' : '已本地实时同步');
      } else {
        setSyncStatus(alreadyExists ? '云端已有该条' : '已实时同步');
      }
      setSyncError('');
    } catch (error) {
      console.error(USE_LOCAL_SYNC_IN_DEV ? '本地同步保存失败:' : '保存到云端失败:', error);
      setSyncError(USE_LOCAL_SYNC_IN_DEV ? '本地同步保存失败，当前数据仍保留在本机' : '保存到云端失败，当前数据仍保留在本机');
    }
  };

  const fetchPreferredLanOrigin = async () => {
    try {
      const response = await fetch(LOCAL_NETWORK_INFO_API_PATH, { cache: 'no-store' });
      if (!response.ok) return '';
      const data = await response.json();

      const candidateUrls = [
        typeof data?.preferredLanUrl === 'string' ? data.preferredLanUrl : '',
        ...(Array.isArray(data?.lanUrls) ? data.lanUrls : []),
      ].filter((item) => typeof item === 'string' && item.trim());

      if (candidateUrls.length === 0) return '';

      const scoreLanUrl = (candidateUrl) => {
        try {
          const hostname = new URL(candidateUrl).hostname;
          let score = 10;

          if (/^192\.168\./.test(hostname)) score += 100;
          else if (/^10\./.test(hostname)) score += 90;
          else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) score += 80;
          else score += 30;

          const lastOctet = hostname.split('.').pop();
          if (lastOctet === '1') score -= 15;

          if (candidateUrl === data?.preferredLanUrl) score += 3;
          return score;
        } catch (error) {
          return -1;
        }
      };

      const bestUrl = [...candidateUrls].sort((a, b) => scoreLanUrl(b) - scoreLanUrl(a))[0];
      if (!bestUrl) return '';
      return new URL(bestUrl).origin;
    } catch (error) {
      return '';
    }
  };

  const buildShareableSyncUrl = async () => {
    const currentUrl = new URL(window.location.href);
    if (!isLoopbackHost(currentUrl.hostname)) {
      return currentUrl;
    }

    const preferredLanOrigin = await fetchPreferredLanOrigin();
    if (!preferredLanOrigin) {
      return currentUrl;
    }

    return new URL(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`, preferredLanOrigin);
  };

  const createShareableSyncUrlString = async (batchValue = syncBatch) => {
    const shareUrl = await buildShareableSyncUrl();
    if (batchValue) {
      shareUrl.searchParams.set('batch', batchValue);
    } else {
      shareUrl.searchParams.delete('batch');
    }
    return shareUrl.toString();
  };

  const isLoopbackUrl = (urlText = '') => {
    try {
      return isLoopbackHost(new URL(urlText).hostname);
    } catch (error) {
      return true;
    }
  };

  const copyPcSyncLink = async () => {
    try {
      const shareUrlText = await createShareableSyncUrlString(syncBatch);
      const shareUrl = new URL(shareUrlText);
      await navigator.clipboard.writeText(shareUrlText);
      setShareableSyncUrl(shareUrlText);

      if (isLoopbackHost(window.location.hostname) && isLoopbackHost(shareUrl.hostname)) {
        setSyncStatus('链接已复制（当前仍是本机地址）');
        setSyncError('未检测到可用局域网地址，请先确认电脑已连接办公室Wi-Fi');
        return;
      }

      setSyncStatus('电脑同步链接已复制');
      setSyncError('');
    } catch (error) {
      setSyncError('复制失败，请手动在电脑端使用相同同步批次号');
    }
  };

  const handleSyncBatchChange = (value) => {
    setSyncBatch(value.trim());
    setRawMaterialSpecs([]);
    setCloudRecordCount(0);
    setLastSyncedAt('');
    setSyncStatus('切换批次，等待同步');
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const shareUrlText = await createShareableSyncUrlString(syncBatch);
      if (!cancelled) {
        setShareableSyncUrl(shareUrlText);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [syncBatch]);


  // 题目定义
  const questions = {
    1: { type: 'selection', title: '请选择产品类型', options: ['成品', '半成品'] },
    2: { type: 'input', title: '请输入序号', placeholder: '序号' },
    3: { type: 'selection', title: '请选择厚度', options: [75, 50, 38, 100, 0.188] },
    4: { type: 'selection', title: '请选择颜色', options: ['蓝色', '透明', '红色', '绿色', '粉红色'] },
    5: { 
      type: 'selection', 
      title: '请选择抗性或防静电', 
      options: [
        '双层双抗硅胶膜', '双层硅胶膜', '单层硅胶膜', 
        '单层单抗硅胶膜', '硅胶膜', '离型膜', 
        '双面防静电离型膜', '防静电离型膜', '原膜'
      ] 
    },
    6: { type: 'input', title: '请输入克重范围', placeholder: '最小值' },
    7: { type: 'input', title: '请输入克重范围', placeholder: '最大值' },
    8: { type: 'input', title: '请输入单卷宽度(mm)', placeholder: '宽度' },
    9: { type: 'input', title: '请输入单卷长度(m)', placeholder: '长度' },
    10: { type: 'input', title: '请输入该规格卷数', placeholder: '卷数' },
    11: { type: 'selection', title: '是否有其他规格?', options: ['是', '保存该条数据添加下一条', '完成并导出'] },
    12: { type: 'input', title: '请输入成品编码', placeholder: '编码' },
    13: { type: 'input', title: '请输入单卷数量(pcs)', placeholder: '数量' },
    14: { type: 'input', title: '请输入共有几卷', placeholder: '卷数' },
    15: { type: 'input', title: '请输入尾数(可为空)', placeholder: '尾数' },
    16: { type: 'selection', title: '是否完成?', options: ['完成并导出', '保存，下一条'] }
  };

  const getNextSequenceNumber = (value) => {
    const numericValue = Number(String(value ?? '').trim());
    if (Number.isFinite(numericValue)) {
      return numericValue + 1;
    }
    return currentSequence + 1;
  };

  // 文件类型验证
  const validateFileType = (file) => {
    const validTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
      'application/octet-stream' // 某些情况下Excel文件可能被识别为此类型
    ];
    
    const validExtensions = ['.xlsx', '.xls'];
    const fileName = file.name.toLowerCase();
    const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext));
    
    return validTypes.includes(file.type) || hasValidExtension;
  };

  // 文件大小验证（限制为10MB）
  const validateFileSize = (file) => {
    const maxSize = 10 * 1024 * 1024; // 10MB
    return file.size <= maxSize;
  };

  // 处理按键输入
  const handleKeyPress = (key) => {
    setFlash(true);
    setTimeout(() => setFlash(false), 100);
    
    if (key === '.') {
      // 防止重复输入小数点
      if (!currentInput.includes('.')) {
        setCurrentInput(prev => prev + key);
      }
    } else {
      setCurrentInput(prev => prev + key);
    }
  };

  // 处理删除键
  const handleDelete = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 100);
    
    setCurrentInput(prev => prev.slice(0, -1));
  };

  // 处理确认按钮
  const handleConfirm = () => {
    // 保存当前答案
    const updatedAnswers = { ...answers, [currentQuestion]: currentInput };
    setAnswers(updatedAnswers);
    if (currentQuestion === 2) {
      const numericSequence = Number(String(currentInput ?? '').trim());
      if (Number.isFinite(numericSequence)) {
        setCurrentSequence(numericSequence);
      }
    }
    setCurrentInput('');
    
    // 根据当前题目和答案决定下一步
    if (currentQuestion === 1) {
      // 第1题选择后进入不同分支
      if (currentInput === '原材料' || currentInput === '半成品') {
        setCurrentQuestion(2);
      } else if (currentInput === '成品') {
        setCurrentQuestion(12); // 跳转到成品分支
      }
    } else if (currentQuestion === 6) {
      // 克重最小值输入完成后进入最大值输入
      setCurrentQuestion(7);
    } else if (currentQuestion === 11) {
      // 原材料分支的"是否有其他规格"选择处理
      if (currentInput === '是') {
        // 保存当前规格数据
        saveRawMaterialSpec();
        // 重置部分答案以重新开始规格输入，但保留序号、厚度、颜色、抗性、克重
        const resetAnswers = { ...updatedAnswers };
        // 保留序号、厚度、颜色、抗性、克重最小值、克重最大值
        // 删除宽度、长度、卷数、是否有其他规格的答案
        delete resetAnswers[8];
        delete resetAnswers[9];
        delete resetAnswers[10];
        delete resetAnswers[11];
        setAnswers(resetAnswers);
        setCurrentQuestion(8); // 跳转到宽度输入
      } else if (currentInput === '保存该条数据添加下一条') {
        // 保存当前规格并添加下一条数据
        // 重置部分答案，但保留产品类型
        const resetAnswers = { ...updatedAnswers };
        // 保留产品类型
        // 删除序号、厚度、颜色、抗性、宽度、长度、卷数、是否有其他规格的答案
        delete resetAnswers[2];
        delete resetAnswers[3];
        delete resetAnswers[4];
        delete resetAnswers[5];
        delete resetAnswers[8];
        delete resetAnswers[9];
        delete resetAnswers[10];
        delete resetAnswers[11];
        setAnswers(resetAnswers);
        // 增加序号并回到序号输入
        setCurrentSequence(getNextSequenceNumber(updatedAnswers[2]));
        setCurrentQuestion(2);
      } else if (currentInput === '完成并导出') {
        // 在导出前保存当前规格数据
        // 先保存当前数据
        const spec = {
          productType: '半成品',
          sequenceNumber: updatedAnswers[2] || currentSequence,
          thickness: updatedAnswers[3],
          color: updatedAnswers[4],
          resistance: updatedAnswers[5],
          weightMin: updatedAnswers[6],
          weightMax: updatedAnswers[7],
          width: updatedAnswers[8],
          length: updatedAnswers[9],
          rollCount: updatedAnswers[10],
          hasOtherSpecs: updatedAnswers[11]
        };
        // 直接将当前规格数据添加到导出数据中，确保不会丢失
        const allSpecs = [...rawMaterialSpecs, spec];
        // 然后导出所有数据
        exportToExcel(allSpecs);
        // 导出后新增一条空白信息
        setShouldExport(true);
      }
    } else if (currentQuestion === 12) {
      // 成品编码输入完成后，立即查找成品名称
      if (currentInput && excelData.length > 0) {
        const foundRow = excelData.find(row => row[0] === currentInput);
        if (foundRow && foundRow[1]) {
          // 更新产品名称映射
          setProductNames(prev => ({
            ...prev,
            [currentInput]: foundRow[1]
          }));
        }
      }
      // 继续到下一题
      setCurrentQuestion(prev => prev + 1);
    } else if (currentQuestion === 16) {
      // 成品分支的"是否完成"选择处理
      if (currentInput === '完成并导出') {
        // 保存成品数据并导出
        saveFinishedProduct(updatedAnswers); // 传递当前答案以确保包含最新数据
        exportToExcel();
      } else {
        // 保存成品数据，重置部分状态，回到成品编码输入
        saveFinishedProduct(updatedAnswers); // 传递当前答案以确保包含最新数据
        // 重置成品相关答案
        const resetAnswers = { ...updatedAnswers };
        delete resetAnswers[12]; // 成品编码
        delete resetAnswers[13]; // 单卷数量
        delete resetAnswers[14]; // 共有几卷
        delete resetAnswers[15]; // 尾数
        delete resetAnswers[16]; // 是否完成
        setAnswers(resetAnswers);
        setRemainders([]); // 清空尾数数组
        setCurrentQuestion(12); // 回到成品编码输入
      }
    } else {
      // 默认下一题
      setCurrentQuestion(prev => prev + 1);
    }
  };

  // 保存原材料规格数据
  const saveRawMaterialSpec = () => {
    const spec = {
      productType: '半成品',
      syncBatch,
      sequenceNumber: answers[2] || currentSequence,
      thickness: answers[3],
      color: answers[4],
      resistance: answers[5],
      weightMin: answers[6],
      weightMax: answers[7],
      width: answers[8],
      length: answers[9],
      rollCount: answers[10],
      hasOtherSpecs: answers[11]
    };
    setRawMaterialSpecs(prev => mergeInventoryRecords(prev, [spec]));
    setSessionSpecs(prev => mergeInventoryRecords(prev, [spec]));
    void syncSpecToCloud(spec);
  };

  // 保存成品数据
  const saveFinishedProduct = (currentAnswers = answers) => {
    // 检查是否已经保存过相同数据
    const productCode = currentAnswers[12];
    const existingProductIndex = rawMaterialSpecs.findIndex(
      item => item.productType === '成品' && item.productCode === productCode
    );
    
    // 确保获取最新的尾数和当前输入值
    const currentRemainders = remainders.join(', ');
    // 获取当前输入值或答案中的完成状态
    const isCompletedValue = currentAnswers[16] || (currentQuestion === 16 ? currentInput : '');
    
    // 查找产品名称
    let productName = '请检查编码';
    if (productCode && excelData.length > 0) {
      const foundRow = excelData.find(row => row[0] === productCode);
      if (foundRow && foundRow[1]) {
        productName = foundRow[1];
      }
    }
    
    const product = {
      productType: '成品',
      syncBatch,
      productCode: currentAnswers[12],
      productName: productName,
      quantityPerRoll: currentAnswers[13],
      totalRolls: currentAnswers[14],
      remainders: currentRemainders, // 使用最新的尾数
      isCompleted: isCompletedValue // 使用当前输入值作为完成状态
    };
    
    if (existingProductIndex >= 0) {
      // 如果已经存在相同成品编码的数据，则更新它
      const updatedSpecs = [...rawMaterialSpecs];
      updatedSpecs[existingProductIndex] = product;
      setRawMaterialSpecs(mergeInventoryRecords([], updatedSpecs));
      console.log('成品数据已更新');
    } else {
      // 如果不存在，则添加新数据
      setRawMaterialSpecs(prev => mergeInventoryRecords(prev, [product]));
      console.log('成品数据已保存');
    }

    setSessionSpecs(prev => mergeInventoryRecords(prev, [product]));

    void syncSpecToCloud(product);
  };

  // 添加尾数
  const addRemainder = () => {
    if (currentInput) {
      setRemainders(prev => [...prev, currentInput]);
      setCurrentInput('');
    }
  };

  // 删除尾数
  const removeRemainder = (index) => {
    setRemainders(prev => prev.filter((_, i) => i !== index));
  };

  // 导出到Excel
  const exportToExcel = async (additionalSpecs = [], options = {}) => {
    try {
      const { resetAfterExport = true, useAdditionalOnly = false } = options;
      const wb = XLSX.utils.book_new();

      let allData = [];
      if (useAdditionalOnly) {
        allData = mergeInventoryRecords([], additionalSpecs);
      } else {
        // 合并本机数据和云端同批次数据，确保手机/电脑任一端录入的数据都会被导出
        let cloudData = [];
        try {
          cloudData = await fetchCloudInventoryRows(syncBatch);
        } catch (error) {
          console.warn('导出前读取云端数据失败，将仅导出本机数据:', error);
        }
        allData = mergeInventoryRecords(rawMaterialSpecs, cloudData);

        // 特别处理成品数据，确保包含最新输入但尚未保存的数据
        if (currentQuestion >= 12 && currentQuestion <= 16) {
          const productCode = answers[12] || currentInput;
          if (productCode) {
            // 检查是否已经存在相同成品编码的数据
            const existingProductIndex = allData.findIndex(
              item => item.productType === '成品' && item.productCode === productCode
            );

            // 查找产品名称
            let productName = '请检查编码';
            if (excelData.length > 0) {
              const foundRow = excelData.find(row => row[0] === productCode);
              if (foundRow && foundRow[1]) {
                productName = foundRow[1];
              }
            }

            // 构建当前成品数据
            const currentRemainders = remainders.join(', ');
            const isCompletedValue = answers[16] || (currentQuestion === 16 ? currentInput : '');

            const currentProduct = {
              productType: '成品',
              productCode: productCode,
              productName: productName,
              quantityPerRoll: answers[13] || '',
              totalRolls: answers[14] || '',
              remainders: currentRemainders,
              isCompleted: isCompletedValue
            };

            if (existingProductIndex >= 0) {
              // 更新现有数据
              allData[existingProductIndex] = currentProduct;
            } else {
              // 添加新数据
              allData.push(currentProduct);
            }
          }
        }

        // 添加额外数据（如果有的话），避免重复
        allData = mergeInventoryRecords(allData, additionalSpecs);
      }

// 转换数据格式
      const data = allData.map((spec, index) => ({
        '序号': spec.sequenceNumber,
        '产品类型': spec.productType,
        '厚度': spec.thickness,
        '颜色': spec.color,
        '抗性或防静电': spec.resistance,
        '克重最小值': spec.weightMin,
        '克重最大值': spec.weightMax,
        '单卷宽度(mm)': spec.width,
        '单卷长度(m)': spec.length,
        '该规格卷数': spec.rollCount,
        '是否有其他规格': spec.hasOtherSpecs,
        '成品编码': spec.productCode,
        '成品名称': spec.productName || '',
        '单卷数量(pcs)': spec.quantityPerRoll,
        '共有几卷': spec.totalRolls,
        '尾数': spec.remainders,
        '是否完成': spec.isCompleted
      }));
      
      const sheetViews = buildWorkbookSheetViews(allData);
      sheetViews.forEach((sheetView) => appendSheetViewToWorkbook(wb, sheetView));

      const rawWs = XLSX.utils.json_to_sheet(data);
      rawWs['!cols'] = [
        { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 },
        { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
        { wch: 16 }, { wch: 14 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 12 }
      ];
      XLSX.utils.book_append_sheet(wb, rawWs, '原始记录');
      
      const mainSheetName = sheetViews[0]?.sheetName || '盘点清单';
      XLSX.writeFile(wb, `${mainSheetName}_盘点数据.xlsx`);
      
      // 保存到后端，供手机和PC端继续同步
      try {
        for (const spec of allData) {
          await syncSpecToCloud(spec);
        }
        console.log('数据已保存到后端');
      } catch (error) {
        console.error('保存数据时出错:', error);
      }
      
      if (resetAfterExport) {
        setRawMaterialSpecs([]);
        setRemainders([]);
        setAnswers({});
        setCurrentQuestion(1);
        setCurrentSequence(1);
      }
    } catch (error) {
      console.error('导出Excel时出错:', error);
      setUploadError('导出Excel文件时发生错误，请重试');
    }
  };

  // 处理选择题答案
  const handleSelection = (value) => {
    const now = Date.now();
    if (now < selectionEventLockUntilRef.current) {
      return;
    }
    selectionEventLockUntilRef.current = now + SELECTION_EVENT_LOCK_MS;

    setFlash(true);
    setTimeout(() => setFlash(false), 100);
    
    // 触发震动反馈
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
    
    // 保存答案
    const updatedAnswers = { ...answers, [currentQuestion]: value };
    setAnswers(updatedAnswers);
    
    // 根据当前题目和答案决定下一步
    if (currentQuestion === 1) {
      if (value === '原材料' || value === '半成品') {
        setCurrentQuestion(2);
      } else if (value === '成品') {
        setCurrentQuestion(12);
      }
      return; // 第一题选择后直接返回，不显示操作按钮
    } else if (currentQuestion === 11) {
      // 避免重复保存数据：只在尚未保存当前规格时才保存
      if (!answers[11]) {
        saveRawMaterialSpec();
      }
      
      if (value === '是') {
        // 重置部分答案以重新开始规格输入，但保留序号、厚度、颜色、抗性、克重
        const resetAnswers = { ...updatedAnswers };
        // 保留序号、厚度、颜色、抗性、克重最小值、克重最大值
        // 删除宽度、长度、卷数、是否有其他规格的答案
        delete resetAnswers[8];
        delete resetAnswers[9];
        delete resetAnswers[10];
        delete resetAnswers[11];
        setAnswers(resetAnswers);
        setCurrentQuestion(8); // 跳转到宽度输入
      } else if (value === '保存该条数据添加下一条') {
        // 重置部分答案，但保留产品类型
        const resetAnswers = { ...updatedAnswers };
        // 保留产品类型
        // 删除序号、厚度、颜色、抗性、宽度、长度、卷数、是否有其他规格的答案
        delete resetAnswers[2];
        delete resetAnswers[3];
        delete resetAnswers[4];
        delete resetAnswers[5];
        delete resetAnswers[8];
        delete resetAnswers[9];
        delete resetAnswers[10];
        delete resetAnswers[11];
        setAnswers(resetAnswers);
        // 增加序号并回到序号输入
        setCurrentSequence(getNextSequenceNumber(updatedAnswers[2]));
        setCurrentQuestion(2);
      } else if (value === '完成并导出') {
        // 在导出前保存当前规格数据（如果尚未保存）
        let allSpecs = [...rawMaterialSpecs];
        if (!answers[11]) {
          const spec = {
            productType: '半成品',
            sequenceNumber: updatedAnswers[2] || currentSequence,
            thickness: updatedAnswers[3],
            color: updatedAnswers[4],
            resistance: updatedAnswers[5],
            weightMin: updatedAnswers[6],
            weightMax: updatedAnswers[7],
            width: updatedAnswers[8],
            length: updatedAnswers[9],
            rollCount: updatedAnswers[10],
            hasOtherSpecs: updatedAnswers[11]
          };
          allSpecs = [...allSpecs, spec];
        }
        // 然后导出所有数据
        exportToExcel(allSpecs);
        // 导出后新增一条空白信息
        setShouldExport(true);
      }
    } else if (currentQuestion === 16) {
      // 确保当前选择的答案也被包含在内
      const finalAnswers = { ...updatedAnswers, [currentQuestion]: value };
      
      // 保存成品数据
      saveFinishedProduct(finalAnswers);
      
      if (value === '完成并导出') {
        // 如果选择"完成并导出"，导出所有数据
        exportToExcel();
      } else {
        // 如果选择"保存，下一条"，重置成品相关答案，回到成品编码输入
        const resetAnswers = { ...finalAnswers };
        delete resetAnswers[12]; // 成品编码
        delete resetAnswers[13]; // 单卷数量
        delete resetAnswers[14]; // 共有几卷
        delete resetAnswers[15]; // 尾数
        delete resetAnswers[16]; // 是否完成
        setAnswers(resetAnswers);
        setRemainders([]); // 清空尾数数组
        setCurrentQuestion(12); // 回到成品编码输入
      }
    } else {
      setCurrentQuestion(prev => prev + 1);
    }
  };

  // 获取当前题目信息
  const getCurrentQuestion = () => {
    if (!questions[currentQuestion]) return null;
    return questions[currentQuestion];
  };

  // 返回上一级
  const handleGoBack = () => {
    // 触发震动反馈
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }
    
    // 特殊处理：如果当前是第一题，不执行任何操作
    if (currentQuestion === 1) {
      return;
    }
    
    // 根据当前题目决定返回的题目
    if (currentQuestion === 2) {
      // 从序号返回到产品类型选择
      setCurrentQuestion(1);
      // 清除已保存的答案
      const resetAnswers = { ...answers };
      delete resetAnswers[1];
      setAnswers(resetAnswers);
    } else if (currentQuestion === 12) {
      // 从成品编码返回到产品类型选择
      setCurrentQuestion(1);
      // 清除已保存的答案
      const resetAnswers = { ...answers };
      delete resetAnswers[1];
      setAnswers(resetAnswers);
    } else {
      // 其他情况返回上一题
      setCurrentQuestion(prev => prev - 1);
      // 清除当前题目的答案
      const resetAnswers = { ...answers };
      delete resetAnswers[currentQuestion];
      setAnswers(resetAnswers);
    }
  };

  // 初始化当前输入值为上一题答案
  useEffect(() => {
    // 特殊处理序号题目的默认值
    if (currentQuestion === 2) {
      // 如果是序号题目，设置默认值为当前序号
      setCurrentInput(String(currentSequence));
    } else {
      setCurrentInput('');
    }
  }, [currentQuestion, currentSequence]);

  // 同步批次变化后保存到本地，PC端使用同一批次号即可读取同一批数据
  useEffect(() => {
    try {
      localStorage.setItem('inventory_sync_batch', syncBatch);
      const url = new URL(window.location.href);
      if (syncBatch && url.searchParams.get('batch') !== syncBatch) {
        url.searchParams.set('batch', syncBatch);
        window.history.replaceState({}, '', url.toString());
      }
    } catch (error) {
      console.warn('保存同步批次失败:', error);
    }
  }, [syncBatch]);

  // 检测是否为移动端：移动端隐藏“实时同步”和“源数据导入整理”模块
  useEffect(() => {
    const handleDeviceChange = () => {
      setIsMobileClient(isMobileClientDevice());
    };

    handleDeviceChange();
    window.addEventListener('resize', handleDeviceChange);
    window.addEventListener('orientationchange', handleDeviceChange);

    return () => {
      window.removeEventListener('resize', handleDeviceChange);
      window.removeEventListener('orientationchange', handleDeviceChange);
    };
  }, []);

  // 准实时同步：每3秒从云端拉取一次同批次数据，让手机端和PC端保持一致
  useEffect(() => {
    let stopped = false;

    const run = async (options = {}) => {
      if (stopped || !syncBatch) return;
      await loadCloudInventory(options);
    };

    run({ replaceLocal: true, silent: false });
    const timer = window.setInterval(() => run({ replaceLocal: false, silent: true }), 3000);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [syncBatch]);

  // 添加 useEffect 监听数据变化并触发导出
  useEffect(() => {
    if (rawMaterialSpecs.length > 0 && shouldExport) {
      exportToExcel(rawMaterialSpecs);
      setShouldExport(false); // 重置标志位
      // 新增一条空白信息
      setCurrentSequence(prev => prev + 1);
      setAnswers({});
      setCurrentQuestion(2);
    }
  }, [rawMaterialSpecs, shouldExport]);

  // 读取源数据并生成盘点明细预览
  const handleSourceInventoryUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setSourceInventoryError('');
    setIsSourceInventoryUploading(true);

    try {
      if (!validateFileType(file)) {
        throw new Error('请上传有效的Excel文件（.xlsx或.xls格式）');
      }

      if (!validateFileSize(file)) {
        throw new Error('文件大小不能超过10MB');
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const arrayBuffer = e.target.result;
          if (!arrayBuffer) throw new Error('文件读取失败，请重试');
          const workbook = XLSX.read(new Uint8Array(arrayBuffer), {
            type: 'array',
            cellDates: true,
            cellNF: false,
            cellText: false
          });
          const inventoryImport = createInventoryImport(workbook, file.name);
          setSourceInventoryImport(inventoryImport);
          event.target.value = '';
        } catch (error) {
          console.error('源数据解析失败:', error);
          setSourceInventoryError(error.message || '源数据解析失败，请检查文件格式');
        } finally {
          setIsSourceInventoryUploading(false);
        }
      };

      reader.onerror = () => {
        setSourceInventoryError('文件读取失败，请重试');
        setIsSourceInventoryUploading(false);
      };

      reader.readAsArrayBuffer(file);
    } catch (error) {
      console.error('源数据上传错误:', error);
      setSourceInventoryError(error.message || '源数据上传失败');
      setIsSourceInventoryUploading(false);
    }
  };

  // 修改字段匹配或起始行后，立即重新生成预览
  const updateSourceInventoryImport = (patch) => {
    if (!sourceInventoryImport) return;
    const nextConfig = {
      ...sourceInventoryImport,
      ...patch,
      mapping: patch.mapping || sourceInventoryImport.mapping
    };
    const rebuilt = rebuildInventoryImport(nextConfig);
    setSourceInventoryImport(rebuilt);
  };

  // 导出源数据整理后的盘点明细
  const exportSourceInventoryDetail = () => {
    if (!sourceInventoryImport) return;
    try {
      const workbook = exportInventoryWorkbook(sourceInventoryImport);
      XLSX.writeFile(workbook, makeInventoryFileName());
    } catch (error) {
      console.error('导出盘点明细失败:', error);
      setSourceInventoryError('导出盘点明细失败，请检查源数据和字段匹配');
    }
  };

  // 改进的文件上传功能
  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // 清除之前的错误信息
    setUploadError('');
    setIsUploading(true);

    try {
      // 验证文件类型
      if (!validateFileType(file)) {
        throw new Error('请上传有效的Excel文件（.xlsx或.xls格式）');
      }

      // 验证文件大小
      if (!validateFileSize(file)) {
        throw new Error('文件大小不能超过10MB');
      }

      const reader = new FileReader();
      
      reader.onload = (e) => {
        try {
          // 使用更安全的方式读取文件
          const arrayBuffer = e.target.result;
          if (!arrayBuffer) {
            throw new Error('文件读取失败，请重试');
          }

          // 创建Uint8Array时添加错误处理
          let data;
          try {
            data = new Uint8Array(arrayBuffer);
          } catch (bufferError) {
            console.error('创建缓冲区失败:', bufferError);
            throw new Error('文件格式不正确或文件已损坏');
          }

          // 使用xlsx读取数据时添加错误处理
          let workbook;
          try {
            workbook = XLSX.read(data, { 
              type: 'array',
              cellDates: true,
              cellNF: false,
              cellText: false
            });
          } catch (xlsxError) {
            console.error('Excel文件解析失败:', xlsxError);
            throw new Error('Excel文件解析失败，请检查文件是否完整');
          }

          if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error('Excel文件中没有找到工作表');
          }

          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          
          if (!worksheet) {
            throw new Error('无法读取Excel工作表内容');
          }

          // 转换为JSON数据
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
            header: 1,
            defval: '',
            blankrows: false
          });

          if (!jsonData || jsonData.length === 0) {
            throw new Error('Excel文件中没有数据');
          }

          setExcelData(jsonData);
          console.log('Excel文件上传成功，共读取', jsonData.length, '行数据');
          
          // 清空文件输入框
          event.target.value = '';
          
        } catch (parseError) {
          console.error('文件解析错误:', parseError);
          setUploadError(parseError.message || '文件解析失败，请检查文件格式');
        } finally {
          setIsUploading(false);
        }
      };

      reader.onerror = () => {
        console.error('文件读取错误');
        setUploadError('文件读取失败，请重试');
        setIsUploading(false);
      };

      reader.onabort = () => {
        console.error('文件读取被中断');
        setUploadError('文件读取被中断');
        setIsUploading(false);
      };

      // 开始读取文件
      reader.readAsArrayBuffer(file);

    } catch (error) {
      console.error('文件上传错误:', error);
      setUploadError(error.message || '文件上传失败');
      setIsUploading(false);
    }
  };

  const isFilled = (value) => value !== undefined && value !== null && String(value).trim() !== '';

  const readAnswer = (questionNumber) => {
    if (currentQuestion === questionNumber && isFilled(currentInput)) {
      return currentInput;
    }
    return answers[questionNumber];
  };

  const addUnit = (value, unit) => {
    if (!isFilled(value)) return '';
    const text = String(value).trim();
    if (text.toLowerCase().endsWith(unit.toLowerCase())) return text;
    return `${text}${unit}`;
  };

  const formatWeightRange = (min, max) => {
    const hasMin = isFilled(min);
    const hasMax = isFilled(max);
    if (hasMin && hasMax) return `${String(min).trim()}-${String(max).trim()}g`;
    if (hasMin) return `${String(min).trim()}g`;
    if (hasMax) return `${String(max).trim()}g`;
    return '';
  };

  const formatRawProductName = (spec = {}) => {
    const productName = [
      addUnit(spec.thickness, 'um'),
      spec.color,
      spec.resistance,
      formatWeightRange(spec.weightMin, spec.weightMax)
    ]
      .filter(isFilled)
      .join('');

    return productName || '未完善产品信息';
  };

  const formatRawSpecText = (spec = {}) => {
    const parts = [];
    if (isFilled(spec.width)) parts.push(addUnit(spec.width, 'mm'));
    if (isFilled(spec.length)) parts.push(addUnit(spec.length, 'm'));
    if (isFilled(spec.rollCount)) parts.push(addUnit(spec.rollCount, 'RL'));
    return parts.join('*') || '未填写规格';
  };

  const formatRawPreviewLine = (spec = {}) => {
    const sequenceNumber = isFilled(spec.sequenceNumber) ? spec.sequenceNumber : currentSequence;
    return `序号${sequenceNumber}｜${formatRawProductName(spec)}｜${formatRawSpecText(spec)}`;
  };

  const formatFinishedPreviewLine = (item = {}) => {
    const code = item.productCode || item[12] || '未填编码';
    const name = item.productName || productNames[code] || '未匹配名称';
    const quantity = item.quantityPerRoll || item[13];
    const rolls = item.totalRolls || item[14];
    const tail = item.remainders || remainders.join(', ');
    const detail = [
      isFilled(quantity) ? `${quantity}pcs` : '',
      isFilled(rolls) ? `${rolls}RL` : '',
      isFilled(tail) ? `尾数${tail}` : ''
    ].filter(Boolean).join('*');

    return `编码${code}｜${name}${detail ? `｜${detail}` : ''}`;
  };

  const getCurrentDraftPreview = () => {
    if (currentQuestion >= 2 && currentQuestion <= 11) {
      return formatRawPreviewLine({
        productType: '半成品',
        sequenceNumber: readAnswer(2) || currentSequence,
        thickness: readAnswer(3),
        color: readAnswer(4),
        resistance: readAnswer(5),
        weightMin: readAnswer(6),
        weightMax: readAnswer(7),
        width: readAnswer(8),
        length: readAnswer(9),
        rollCount: readAnswer(10)
      });
    }

    if (currentQuestion >= 12 && currentQuestion <= 16) {
      return formatFinishedPreviewLine({
        productCode: readAnswer(12),
        productName: productNames[readAnswer(12)],
        quantityPerRoll: readAnswer(13),
        totalRolls: readAnswer(14),
        remainders: remainders.join(', ')
      });
    }

    return '请选择产品类型后开始记录';
  };

  const getSavedPreviewRows = () => {
    const recentRows = rawMaterialSpecs.slice(-3);
    const labelsByCount = {
      1: ['最新'],
      2: ['上一条', '最新'],
      3: ['上上条', '上一条', '最新']
    };
    const labels = labelsByCount[recentRows.length] || [];

    return recentRows.map((item, index) => ({
      label: labels[index],
      text: item.productType === '成品'
        ? formatFinishedPreviewLine(item)
        : formatRawPreviewLine(item)
    }));
  };

  const readNumericValue = (value) => {
    if (!isFilled(value)) return null;
    const match = String(value).replace(/，/g, '.').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  };

  const roundArea = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

  const calculateRawArea = (spec = {}) => {
    const width = readNumericValue(spec.width);
    const length = readNumericValue(spec.length);
    const rollCount = readNumericValue(spec.rollCount);
    if (width === null || length === null || rollCount === null) return '';
    return roundArea((width * length * rollCount) / 1000);
  };

  const sumFinishedTailQuantity = (value) => {
    if (!isFilled(value)) return 0;
    return String(value)
      .split(/[,+，、\s]+/)
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
      .reduce((sum, item) => sum + item, 0);
  };

  const buildHalfProductGroupedRows = (items = []) => {
    const grouped = new Map();

    items.forEach((item, index) => {
      const sequenceValue = isFilled(item.sequenceNumber) ? String(item.sequenceNumber).trim() : '';
      const productName = formatRawProductName(item);
      const groupKey = `${sequenceValue}|${productName}`;

      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          __groupKey: groupKey,
          sequenceNumber: isFilled(item.sequenceNumber) ? item.sequenceNumber : '',
          productName,
          specs: [],
          specSet: new Set(),
          areaSum: 0,
          hasArea: false,
          memberRecordKeys: [],
          order: index,
        });
      }

      const current = grouped.get(groupKey);
      const specText = formatRawSpecText(item);
      if (specText && specText !== '未填写规格' && !current.specSet.has(specText)) {
        current.specSet.add(specText);
        current.specs.push(specText);
      }

      const areaValue = calculateRawArea(item);
      if (areaValue !== '' && Number.isFinite(Number(areaValue))) {
        current.areaSum += Number(areaValue);
        current.hasArea = true;
      }

      if (item.__recordKey) {
        current.memberRecordKeys.push(item.__recordKey);
      }
    });

    return Array.from(grouped.values())
      .sort((a, b) => a.order - b.order)
      .map(({ specSet, order, specs, ...item }) => ({
        ...item,
        specText: specs.join('+'),
        area: item.hasArea ? roundArea(item.areaSum) : '',
        memberRecordKeys: Array.from(new Set(item.memberRecordKeys)),
      }));
  };

  const buildHalfProductSheetRows = (items = []) => buildHalfProductGroupedRows(items).map((item, index) => ([
    isFilled(item.sequenceNumber) ? item.sequenceNumber : index + 1,
    item.productName,
    item.specText || '',
    item.area === '' ? '' : item.area
  ]));

  const buildFinishedProductSheetRows = (items = []) => items.map((item, index) => {
    const quantity = readNumericValue(item.quantityPerRoll);
    const rolls = readNumericValue(item.totalRolls);
    const tailSum = sumFinishedTailQuantity(item.remainders);
    const total = quantity !== null && rolls !== null ? quantity * rolls + tailSum : '';
    const detail = [
      isFilled(item.quantityPerRoll) ? `${item.quantityPerRoll}pcs` : '',
      isFilled(item.totalRolls) ? `${item.totalRolls}RL` : '',
      isFilled(item.remainders) ? `尾数${item.remainders}` : ''
    ].filter(Boolean).join('*');

    return [
      isFilled(item.sequenceNumber) ? item.sequenceNumber : index + 1,
      item.productCode || '',
      item.productName || productNames[item.productCode] || '请检查编码',
      detail,
      total
    ];
  });

  const buildWorkbookSheetViews = (items = []) => {
    const halfProductItems = items.filter((item) => item.productType && item.productType !== '成品');
    const finishedProductItems = items.filter((item) => item.productType === '成品');
    const views = [];

    if (halfProductItems.length > 0) {
      views.push({
        sheetName: '半成品',
        headers: ['序号', '材料&产品名称', '规格', '面积'],
        rows: buildHalfProductSheetRows(halfProductItems),
        widths: [{ wch: 8 }, { wch: 38 }, { wch: 72 }, { wch: 12 }]
      });
    }

    if (finishedProductItems.length > 0) {
      views.push({
        sheetName: '成品',
        headers: ['序号', '成品编码', '成品名称', '数量明细', '合计pcs'],
        rows: buildFinishedProductSheetRows(finishedProductItems),
        widths: [{ wch: 8 }, { wch: 18 }, { wch: 36 }, { wch: 42 }, { wch: 14 }]
      });
    }

    if (views.length === 0) {
      const defaultType = answers[1] === '成品' ? '成品' : '半成品';
      views.push({
        sheetName: defaultType,
        headers: defaultType === '成品' ? ['序号', '成品编码', '成品名称', '数量明细', '合计pcs'] : ['序号', '材料&产品名称', '规格', '面积'],
        rows: [],
        widths: defaultType === '成品'
          ? [{ wch: 8 }, { wch: 18 }, { wch: 36 }, { wch: 42 }, { wch: 14 }]
          : [{ wch: 8 }, { wch: 38 }, { wch: 72 }, { wch: 12 }]
      });
    }

    return views;
  };

  const appendSheetViewToWorkbook = (workbook, sheetView) => {
    const worksheet = XLSX.utils.aoa_to_sheet([sheetView.headers, ...sheetView.rows]);
    worksheet['!cols'] = sheetView.widths;
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    worksheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(sheetView.rows.length, 1), c: sheetView.headers.length - 1 } }) };
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetView.sheetName);
  };

  const sessionPreviewRecords = React.useMemo(
    () => sessionSpecs.map((item, index) => ({
      ...item,
      __recordKey: item.recordKey || makeSpecRecordKey(item, item.syncBatch || syncBatch) || `session-${index}`,
    })),
    [sessionSpecs, syncBatch]
  );

  const visiblePreviewRecords = React.useMemo(() => {
    if (listExportScope === 'session') return sessionPreviewRecords;
    return sessionPreviewRecords.filter((item) => !item.syncBatch || item.syncBatch === syncBatch);
  }, [sessionPreviewRecords, listExportScope, syncBatch]);

  const selectedPreviewRecords = React.useMemo(
    () => visiblePreviewRecords.filter((item) => selectedRecordKeys.includes(item.__recordKey)),
    [visiblePreviewRecords, selectedRecordKeys]
  );

  const halfPreviewRecords = React.useMemo(
    () => visiblePreviewRecords.filter((item) => item.productType && item.productType !== '成品'),
    [visiblePreviewRecords]
  );

  const halfPreviewGroups = React.useMemo(
    () => buildHalfProductGroupedRows(halfPreviewRecords),
    [halfPreviewRecords]
  );

  const finishedPreviewRecords = React.useMemo(
    () => visiblePreviewRecords.filter((item) => item.productType === '成品'),
    [visiblePreviewRecords]
  );

  useEffect(() => {
    setSelectedRecordKeys((prev) =>
      prev.filter((key) => visiblePreviewRecords.some((item) => item.__recordKey === key))
    );
  }, [visiblePreviewRecords]);

  const toggleRecordSelection = (recordKey) => {
    setSelectedRecordKeys((prev) => (
      prev.includes(recordKey)
        ? prev.filter((item) => item !== recordKey)
        : [...prev, recordKey]
    ));
  };

  const isHalfGroupSelected = (group) => (
    Array.isArray(group.memberRecordKeys)
    && group.memberRecordKeys.length > 0
    && group.memberRecordKeys.every((key) => selectedRecordKeys.includes(key))
  );

  const toggleHalfGroupSelection = (group) => {
    const keys = Array.isArray(group.memberRecordKeys) ? group.memberRecordKeys.filter(Boolean) : [];
    if (keys.length === 0) return;

    setSelectedRecordKeys((prev) => {
      const allSelected = keys.every((key) => prev.includes(key));
      if (allSelected) {
        return prev.filter((key) => !keys.includes(key));
      }
      const next = new Set(prev);
      keys.forEach((key) => next.add(key));
      return Array.from(next);
    });
  };

  const selectAllVisibleRecords = () => {
    setSelectedRecordKeys(visiblePreviewRecords.map((item) => item.__recordKey));
  };

  const handleListExport = () => {
    const exportRecords = selectedPreviewRecords.length > 0 ? selectedPreviewRecords : visiblePreviewRecords;
    if (exportRecords.length === 0) {
      setSyncError('暂无可导出数据，请先录入或同步数据。');
      return;
    }

    setSyncError('');
    exportToExcel(exportRecords, { resetAfterExport: false, useAdditionalOnly: true });
  };

  const question = getCurrentQuestion();
  
  if (!question) {
    return <div>题目加载中...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      {!isMobileClient && (
        <div className="mb-4 rounded-lg border border-indigo-100 bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-gray-900">手机 / PC 实时同步</h2>
              <p className="mt-1 text-xs text-gray-500">手机和电脑打开同一个链接，或填同一个同步批次号，保存后约3秒内同步。</p>
            </div>
            <div className="text-right text-xs text-gray-500">
              <div>{isSyncing ? '同步中...' : syncStatus}</div>
              <div>云端 {cloudRecordCount} 条{lastSyncedAt ? `｜${lastSyncedAt}` : ''}</div>
            </div>
          </div>
  
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <input
              value={syncBatch}
              onChange={(e) => handleSyncBatchChange(e.target.value)}
              placeholder="同步批次号，例如 2026-03-28"
              className="min-w-0 rounded border border-gray-200 px-2 py-2 text-sm"
            />
            <Button type="button" variant="outline" onClick={() => loadCloudInventory({ replaceLocal: true, silent: false })}>
              立即同步
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowSyncedList(prev => !prev)}>
              {showSyncedList ? '隐藏清单' : '查看清单'}
            </Button>
            <Button type="button" onClick={copyPcSyncLink}>
              复制PC链接
            </Button>
          </div>

          <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-2">
            <div className="mb-1 text-[11px] text-gray-500">当前可分享地址（发手机）</div>
            <div className="rounded border border-gray-200 bg-white px-2 py-2 text-xs text-gray-700 break-all">
              {shareableSyncUrl || '正在生成可分享地址...'}
            </div>
            {shareableSyncUrl && isLoopbackUrl(shareableSyncUrl) && (
              <div className="mt-1 text-[11px] text-amber-600">
                当前是本机地址，请确认电脑已连接办公室 Wi-Fi 后再复制。
              </div>
            )}
          </div>

          {syncError && (
            <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-600">
              {syncError}
            </div>
          )}

          {showSyncedList && (
            <div className="mt-3 rounded border border-gray-200 bg-gray-50 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs text-gray-500">
                  清单预览：显示本次程序启动后累计数据（{sessionSpecs.length} 条）
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={listExportScope}
                    onChange={(event) => setListExportScope(event.target.value)}
                    className="h-8 rounded border border-gray-200 bg-white px-2 text-xs text-gray-700"
                  >
                    <option value="session">导出本次启动全部</option>
                    <option value="current">仅导出当前批次</option>
                  </select>
                  <Button type="button" size="sm" variant="outline" onClick={handleListExport}>
                  导出清单
                  </Button>
                </div>
              </div>

              {visiblePreviewRecords.length > 0 ? (
                <div className="max-h-96 space-y-3 overflow-y-auto">
                  <div className="flex items-center justify-between rounded bg-white px-3 py-2 text-xs text-gray-600">
                    <div>已选 {selectedPreviewRecords.length} 条，未勾选时默认导出当前范围全部。</div>
                    <div className="flex items-center gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={selectAllVisibleRecords}>
                        全选当前
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setSelectedRecordKeys([])}>
                        清空选择
                      </Button>
                    </div>
                  </div>

                  {halfPreviewGroups.length > 0 && (
                    <div className="overflow-x-auto rounded bg-white shadow-sm">
                      <div className="border-b bg-gray-100 px-3 py-2 text-sm font-bold text-gray-800">半成品</div>
                      <table className="min-w-full border-collapse text-xs text-gray-800">
                        <thead>
                          <tr>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">选择</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">序号</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">材料&产品名称</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">规格</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">面积</th>
                          </tr>
                        </thead>
                        <tbody>
                          {halfPreviewGroups.map((item, rowIndex) => (
                            <tr key={`half-${item.__groupKey}-${rowIndex}`}>
                              <td className="border border-gray-300 px-2 py-2 text-center whitespace-nowrap">
                                <input
                                  type="checkbox"
                                  checked={isHalfGroupSelected(item)}
                                  onChange={() => toggleHalfGroupSelection(item)}
                                />
                              </td>
                              <td className="border border-gray-300 px-2 py-2 text-center whitespace-nowrap">
                                {isFilled(item.sequenceNumber) ? item.sequenceNumber : rowIndex + 1}
                              </td>
                              <td className="border border-gray-300 px-2 py-2 text-left">{item.productName}</td>
                              <td className="border border-gray-300 px-2 py-2 text-left">
                                {item.specText || ''}
                              </td>
                              <td className="border border-gray-300 px-2 py-2 text-center whitespace-nowrap">
                                {item.area}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {finishedPreviewRecords.length > 0 && (
                    <div className="overflow-x-auto rounded bg-white shadow-sm">
                      <div className="border-b bg-gray-100 px-3 py-2 text-sm font-bold text-gray-800">成品</div>
                      <table className="min-w-full border-collapse text-xs text-gray-800">
                        <thead>
                          <tr>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">选择</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">序号</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">成品编码</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">成品名称</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">数量明细</th>
                            <th className="border border-gray-300 bg-white px-2 py-2 text-center font-bold whitespace-nowrap">合计pcs</th>
                          </tr>
                        </thead>
                        <tbody>
                          {finishedPreviewRecords.map((item, rowIndex) => {
                            const quantity = readNumericValue(item.quantityPerRoll);
                            const rolls = readNumericValue(item.totalRolls);
                            const tailSum = sumFinishedTailQuantity(item.remainders);
                            const total = quantity !== null && rolls !== null ? quantity * rolls + tailSum : '';
                            const detail = [
                              isFilled(item.quantityPerRoll) ? `${item.quantityPerRoll}pcs` : '',
                              isFilled(item.totalRolls) ? `${item.totalRolls}RL` : '',
                              isFilled(item.remainders) ? `尾数${item.remainders}` : ''
                            ].filter(Boolean).join('*');

                            return (
                              <tr key={`finished-${item.__recordKey}-${rowIndex}`}>
                                <td className="border border-gray-300 px-2 py-2 text-center whitespace-nowrap">
                                  <input
                                    type="checkbox"
                                    checked={selectedRecordKeys.includes(item.__recordKey)}
                                    onChange={() => toggleRecordSelection(item.__recordKey)}
                                  />
                                </td>
                                <td className="border border-gray-300 px-2 py-2 text-center whitespace-nowrap">
                                  {isFilled(item.sequenceNumber) ? item.sequenceNumber : rowIndex + 1}
                                </td>
                                <td className="border border-gray-300 px-2 py-2 text-center whitespace-nowrap">{item.productCode || ''}</td>
                                <td className="border border-gray-300 px-2 py-2 text-left">
                                  {item.productName || productNames[item.productCode] || '请检查编码'}
                                </td>
                                <td className="border border-gray-300 px-2 py-2 text-left">{detail}</td>
                                <td className="border border-gray-300 px-2 py-2 text-center whitespace-nowrap">{total}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : (
                <div className="px-2 py-3 text-xs text-gray-400">暂无记录，保存一条后这里会累计显示本次启动的全部数据。</div>
              )}
            </div>
          )}
        </div>
      )}

      {!isMobileClient && (
        <div className="mb-4 p-4 bg-white rounded-lg border border-blue-100 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">源数据导入整理</h2>
              <p className="text-xs text-gray-500 mt-1">上传源数据后，自动清洗单位、合并同产品名称、生成“盘点明细”。</p>
            </div>
            {sourceInventoryImport && (
              <Button onClick={exportSourceInventoryDetail} className="shrink-0">
                导出盘点明细
              </Button>
            )}
          </div>

          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={handleSourceInventoryUpload}
            disabled={isSourceInventoryUploading}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-green-50 file:text-green-700 hover:file:bg-green-100 disabled:opacity-50"
          />

          {isSourceInventoryUploading && (
            <div className="mt-2 text-sm text-blue-600">正在读取源数据...</div>
          )}

          {sourceInventoryError && (
            <div className="mt-2 text-sm text-red-600 bg-red-50 p-2 rounded">
              {sourceInventoryError}
            </div>
          )}

          {sourceInventoryImport && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-2 text-sm text-gray-700">
                <div className="bg-gray-50 rounded p-2">文件：{sourceInventoryImport.fileName || '未命名'}</div>
                <div className="bg-gray-50 rounded p-2">工作表：{sourceInventoryImport.sheetName || '第一个Sheet'}</div>
                <div className="bg-green-50 rounded p-2">有效明细：{sourceInventoryImport.groupedRows.length} 条</div>
                <div className="bg-yellow-50 rounded p-2">异常行：{sourceInventoryImport.errors.length} 行</div>
              </div>

              <div className="bg-gray-50 rounded p-3">
                <div className="flex items-center gap-2 mb-3">
                  <label className="text-sm font-semibold text-gray-700">数据从第几行开始</label>
                  <input
                    type="number"
                    min="1"
                    value={sourceInventoryImport.startRow}
                    onChange={(e) => updateSourceInventoryImport({ startRow: e.target.value })}
                    className="w-20 border rounded px-2 py-1 text-sm"
                  />
                  <span className="text-xs text-gray-500">如果第一行是表头，通常填 2。</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(INVENTORY_FIELD_LABELS).map(([field, label]) => (
                    <label key={field} className="text-xs text-gray-600">
                      {label}
                      <select
                        value={sourceInventoryImport.mapping[field] ?? ''}
                        onChange={(e) => updateSourceInventoryImport({
                          mapping: {
                            ...sourceInventoryImport.mapping,
                            [field]: Number(e.target.value)
                          }
                        })}
                        className="mt-1 w-full border rounded px-2 py-1 bg-white text-sm"
                      >
                        {Array.from({ length: 20 }).map((_, index) => (
                          <option key={index} value={index}>
                            {columnNameFromIndex(index)}列
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              {sourceInventoryImport.groupedRows.length > 0 && (
                <div className="overflow-x-auto border rounded">
                  <table className="min-w-full text-xs bg-white">
                    <thead className="bg-gray-100 text-gray-700">
                      <tr>
                        <th className="px-2 py-2 text-left">序号</th>
                        <th className="px-2 py-2 text-left">产品名称</th>
                        <th className="px-2 py-2 text-left">规格</th>
                        <th className="px-2 py-2 text-right">面积</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourceInventoryImport.groupedRows.slice(0, 5).map((row) => (
                        <tr key={row.sequence} className="border-t">
                          <td className="px-2 py-2">{row.sequence}</td>
                          <td className="px-2 py-2 whitespace-nowrap">{row.productName}</td>
                          <td className="px-2 py-2 min-w-72">{row.spec}</td>
                          <td className="px-2 py-2 text-right">{row.area}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sourceInventoryImport.groupedRows.length > 5 && (
                    <div className="px-2 py-2 text-xs text-gray-500 bg-gray-50">
                      这里只预览前5条，导出会包含全部数据。
                    </div>
                  )}
                </div>
              )}

              {sourceInventoryImport.errors.length > 0 && (
                <div className="bg-yellow-50 border border-yellow-100 rounded p-3 text-xs text-yellow-800">
                  <div className="font-semibold mb-1">异常提示：</div>
                  {sourceInventoryImport.errors.slice(0, 5).map((error) => (
                    <div key={error.rowNumber}>第 {error.rowNumber} 行：{error.message}</div>
                  ))}
                  {sourceInventoryImport.errors.length > 5 && <div>还有 {sourceInventoryImport.errors.length - 5} 行异常，导出的“清洗明细”里会列全。</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 文件上传区域 */}
      <div className="mb-4">
        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={handleFileUpload}
          disabled={isUploading}
          className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
        />
        
        {/* 上传状态提示 */}
        {isUploading && (
          <div className="mt-2 text-sm text-blue-600">
            正在处理文件，请稍候...
          </div>
        )}
        
        {/* 错误提示 */}
        {uploadError && (
          <div className="mt-2 text-sm text-red-600 bg-red-50 p-2 rounded">
            {uploadError}
          </div>
        )}
        
        {/* 成功提示 */}
        {excelData.length > 0 && !uploadError && !isUploading && (
          <div className="mt-2 text-sm text-green-600 bg-green-50 p-2 rounded">
            Excel文件已成功加载，共 {excelData.length} 行数据
          </div>
        )}
        
        {/* 文件格式说明 */}
        <div className="mt-2 text-xs text-gray-400">
          支持格式：.xlsx, .xls | 最大文件大小：10MB
        </div>
      </div>

      {/* 顶部灰字滚动记录区域 */}
      <div className="mb-4 rounded-lg bg-gray-100 px-3 py-2 text-[11px] leading-4 text-gray-600 sm:text-[12px] sm:leading-5">
        <div className="mb-1 flex items-center justify-between text-[10px] text-gray-400 sm:text-[11px]">
          <span>数据滚动记录</span>
          <span>向上轮动</span>
        </div>
        <div className="space-y-1">
          {getSavedPreviewRows().length > 0 ? (
            getSavedPreviewRows().map((row) => (
              <div key={`${row.label}-${row.text}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[1ch]">
                <span className="whitespace-nowrap text-gray-400">{row.label}</span>
                <span className="min-w-0 break-all whitespace-normal sm:truncate sm:whitespace-nowrap">{row.text}</span>
              </div>
            ))
          ) : (
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[1ch]">
              <span className="whitespace-nowrap text-gray-400">已保存</span>
              <span className="min-w-0 break-all whitespace-normal sm:truncate sm:whitespace-nowrap">暂无，保存第一条后这里会自动轮动</span>
            </div>
          )}

          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[1ch] border-t border-gray-200 pt-1">
            <span className="whitespace-nowrap text-gray-400">当前</span>
            <span className="min-w-0 break-all whitespace-normal sm:truncate sm:whitespace-nowrap">{getCurrentDraftPreview()}</span>
          </div>
        </div>
      </div>

      {/* 题目标题 */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-center">{question.title}</h1>
      </div>

      {/* 题目内容 */}
      <div className="mb-6">
        {question.type === 'input' ? (
          <div className="space-y-4">
            {currentQuestion === 15 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {remainders.map((r, index) => (
                  <div key={index} className="flex items-center bg-blue-100 rounded-full pl-3 pr-2 py-1">
                    <span className="text-sm">{r}</span>
                    <button 
                      onClick={() => removeRemainder(index)}
                      className="ml-1 text-red-500 hover:text-red-700 font-bold"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={`p-4 bg-white rounded-lg text-right text-2xl min-h-16 flex items-center justify-end ${flash ? 'bg-blue-100' : ''}`}>
              {currentInput || '0'}
            </div>
            
            {currentQuestion === 2 && (
              <p className="text-sm text-gray-500">当前序号 = {currentSequence}</p>
            )}
            
            {currentQuestion === 15 && (
              <Button onClick={addRemainder} className="w-full" variant="outline">
                添加尾数
              </Button>
            )}
          </div>
        ) : (
          <SelectionQuestion 
            key={currentQuestion}
            questionKey={currentQuestion}
            options={question.options} 
            onSelect={handleSelection} 
            selectedValue={answers[currentQuestion]} 
          />
        )}
      </div>

      {/* 自定义数字键盘 */}
      {question.type === 'input' && (
        <CustomKeypad 
          onKeyPress={handleKeyPress} 
          onConfirm={handleConfirm}
          onDelete={handleDelete}
          confirmText={currentQuestion === 15 ? "确认尾数" : "确认"}
        />
      )}

      {/* 操作按钮区 */}
      <div className="mt-4 flex justify-between">
        {currentQuestion !== 1 && (
          <Button onClick={handleGoBack} variant="outline">
            返回上一级
          </Button>
        )}
        
      </div>
    </div>
  );
}
