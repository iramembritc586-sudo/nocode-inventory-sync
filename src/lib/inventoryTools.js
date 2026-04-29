import * as XLSX from 'xlsx';

export const INVENTORY_FIELD_LABELS = {
  thickness: '厚度 / um',
  color: '颜色',
  material: '材料/产品名称',
  weightMin: '克重下限',
  weightMax: '克重上限',
  width: '宽度 / mm',
  length: '长度 / m',
  rollCount: '卷数 / RL'
};

export const DEFAULT_INVENTORY_MAPPING = {
  thickness: 2,
  color: 3,
  material: 4,
  weightMin: 5,
  weightMax: 6,
  width: 7,
  length: 8,
  rollCount: 9
};

const FIELD_KEYWORDS = {
  thickness: ['厚度', '材料厚度'],
  color: ['颜色', '色别', '色系'],
  material: ['材料', '产品名称', '品名', '名称', '类型'],
  weightMin: ['克重下限', '最小克重', '下限', '克重最小', 'min'],
  weightMax: ['克重上限', '最大克重', '上限', '克重最大', 'max'],
  width: ['宽度', '宽', 'mm'],
  length: ['长度', '长', '米数', 'm'],
  rollCount: ['卷数', 'rl', 'roll', '数量']
};

export const columnNameFromIndex = (index) => {
  if (index === '' || index === null || index === undefined) return '未选择';
  let n = Number(index) + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return String(value.getTime());
  return String(value).replace(/\u00a0/g, ' ').trim();
};

const compactText = (value) => cellText(value).replace(/\s+/g, '');

const rowHasValue = (row) => Array.isArray(row) && row.some((cell) => cellText(cell) !== '');

const normalizeNumberText = (value) => {
  const text = compactText(value)
    .replace(/，/g, '.')
    .replace(/。/g, '.')
    .replace(/－/g, '-')
    .replace(/—/g, '-')
    .replace(/~/g, '-');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : '';
};

const normalizeNumber = (value) => {
  const numText = normalizeNumberText(value);
  if (numText === '') return null;
  const num = Number(numText);
  return Number.isFinite(num) ? num : null;
};

const formatNumber = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return cellText(value);
  return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(4))).replace(/\.0+$/, '');
};

const extractWeightRange = (minValue, maxValue) => {
  const minText = compactText(minValue);
  const maxText = compactText(maxValue);
  const combined = minText && !maxText ? minText : `${minText}-${maxText}`;
  const rangeMatch = combined.match(/(\d+(?:\.\d+)?)\s*(?:-|~|至|到)\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    return [formatNumber(rangeMatch[1]), formatNumber(rangeMatch[2])];
  }
  return [formatNumber(normalizeNumber(minText)), formatNumber(normalizeNumber(maxText))];
};

const makeProductName = ({ thickness, color, material, weightMin, weightMax }) => {
  const thicknessText = formatNumber(thickness);
  const colorText = compactText(color);
  const materialText = compactText(material);
  const [minWeight, maxWeight] = extractWeightRange(weightMin, weightMax);
  const weightText = minWeight && maxWeight ? `${minWeight}-${maxWeight}g` : minWeight ? `${minWeight}g` : maxWeight ? `${maxWeight}g` : '';
  return `${thicknessText ? `${thicknessText}um` : ''}${colorText}${materialText}${weightText}`;
};

const makeSpec = ({ width, length, rollCount }) => {
  const widthText = formatNumber(width);
  const lengthText = formatNumber(length);
  const rollText = formatNumber(rollCount);
  if (!widthText || !lengthText || !rollText) return '';
  return `${widthText}mm*${lengthText}m*${rollText}RL`;
};

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const inferInventoryMapping = (rows) => {
  const scanRows = rows.slice(0, 12);
  let best = { rowIndex: -1, score: 0, mapping: { ...DEFAULT_INVENTORY_MAPPING } };

  scanRows.forEach((row, rowIndex) => {
    const mapping = { ...DEFAULT_INVENTORY_MAPPING };
    let score = 0;
    Object.keys(FIELD_KEYWORDS).forEach((field) => {
      const keywords = FIELD_KEYWORDS[field];
      const foundIndex = row.findIndex((cell) => {
        const text = compactText(cell).toLowerCase();
        return keywords.some((kw) => text.includes(kw.toLowerCase()));
      });
      if (foundIndex >= 0) {
        mapping[field] = foundIndex;
        score += 1;
      }
    });
    if (score > best.score) best = { rowIndex, score, mapping };
  });

  if (best.score >= 3) {
    return { mapping: best.mapping, startRow: best.rowIndex + 1, headerRow: best.rowIndex };
  }

  return { mapping: { ...DEFAULT_INVENTORY_MAPPING }, startRow: 0, headerRow: -1 };
};

export const rebuildInventoryImport = ({ rows, mapping, startRow = 1, fileName = '', sheetName = '' }) => {
  const cleanRows = [];
  const errors = [];
  const groups = new Map();
  const startIndex = Math.max(0, Number(startRow || 1) - 1);

  rows.slice(startIndex).forEach((row, localIndex) => {
    const rowIndex = startIndex + localIndex;
    if (!rowHasValue(row)) return;

    const source = {
      thickness: row[mapping.thickness],
      color: row[mapping.color],
      material: row[mapping.material],
      weightMin: row[mapping.weightMin],
      weightMax: row[mapping.weightMax],
      width: row[mapping.width],
      length: row[mapping.length],
      rollCount: row[mapping.rollCount]
    };

    const thicknessNum = normalizeNumber(source.thickness);
    const widthNum = normalizeNumber(source.width);
    const lengthNum = normalizeNumber(source.length);
    const rollNum = normalizeNumber(source.rollCount);
    const productName = makeProductName(source);
    const spec = makeSpec({ width: widthNum, length: lengthNum, rollCount: rollNum });
    const area = widthNum !== null && lengthNum !== null && rollNum !== null ? round2((widthNum * lengthNum * rollNum) / 1000) : null;
    const rowErrors = [];

    if (!productName) rowErrors.push('产品名称生成失败');
    if (thicknessNum === null) rowErrors.push('厚度为空或格式异常');
    if (!compactText(source.color)) rowErrors.push('颜色为空');
    if (!compactText(source.material)) rowErrors.push('材料/产品名称为空');
    if (widthNum === null) rowErrors.push('宽度为空或格式异常');
    if (lengthNum === null) rowErrors.push('长度为空或格式异常');
    if (rollNum === null) rowErrors.push('卷数为空或格式异常');

    const cleaned = {
      sourceRowNumber: rowIndex + 1,
      productName,
      spec,
      area,
      thickness: thicknessNum === null ? '' : formatNumber(thicknessNum),
      color: compactText(source.color),
      material: compactText(source.material),
      weightMin: extractWeightRange(source.weightMin, source.weightMax)[0],
      weightMax: extractWeightRange(source.weightMin, source.weightMax)[1],
      width: widthNum === null ? '' : formatNumber(widthNum),
      length: lengthNum === null ? '' : formatNumber(lengthNum),
      rollCount: rollNum === null ? '' : formatNumber(rollNum),
      errorText: rowErrors.join('；')
    };

    cleanRows.push(cleaned);
    if (rowErrors.length > 0) {
      errors.push({ rowNumber: rowIndex + 1, message: cleaned.errorText });
      return;
    }

    if (!groups.has(productName)) {
      groups.set(productName, { productName, specs: [], area: 0, sourceRows: [] });
    }
    const group = groups.get(productName);
    group.specs.push(spec);
    group.area += area;
    group.sourceRows.push(rowIndex + 1);
  });

  const groupedRows = Array.from(groups.values()).map((group, index) => ({
    sequence: index + 1,
    productName: group.productName,
    spec: group.specs.join('+'),
    area: round2(group.area),
    sourceRows: group.sourceRows.join(', ')
  }));

  return { fileName, sheetName, rows, mapping, startRow: Number(startRow || 1), cleanRows, groupedRows, errors };
};

export const createInventoryImport = (workbook, fileName = '') => {
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false });
  const inferred = inferInventoryMapping(rows);
  return rebuildInventoryImport({
    rows,
    mapping: inferred.mapping,
    startRow: inferred.startRow + 1,
    fileName,
    sheetName: firstSheetName
  });
};

const formulaRows = () => ([
  ['说明', '放置位置', '公式文本（前面带撇点，删掉撇点后可用）'],
  ['源数据辅助：产品名称，假设 C:J 为厚度/颜色/材料/克重下限/克重上限/宽/长/卷', '源数据!K2', '\'=TRIM(SUBSTITUTE(SUBSTITUTE(C2,"um","") ," ","")&"um"&D2&E2&F2&IF(G2<>"","-"&G2,"")&"g")'],
  ['源数据辅助：规格', '源数据!L2', '\'=TRIM(SUBSTITUTE(SUBSTITUTE(H2,"mm","") ," ","")&"mm*"&SUBSTITUTE(SUBSTITUTE(I2,"m","") ," ","")&"m*"&SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(J2,"RL","") ,"卷","") ," ","")&"RL")'],
  ['源数据辅助：面积', '源数据!M2', '\'=VALUE(SUBSTITUTE(H2,"mm", ""))*VALUE(SUBSTITUTE(I2,"m", ""))*VALUE(SUBSTITUTE(SUBSTITUTE(J2,"RL", ""),"卷", ""))/1000'],
  ['盘点明细：序号', '盘点明细!A2', '\'=ROW()-1'],
  ['盘点明细：产品名称去重（Excel 365/WPS新版）', '盘点明细!B2', '\'=UNIQUE(FILTER(源数据!K:K,源数据!K:K<>""))'],
  ['盘点明细：同品名规格合并', '盘点明细!C2', '\'=TEXTJOIN("+",TRUE,FILTER(源数据!L:L,源数据!K:K=B2))'],
  ['盘点明细：同品名面积合计', '盘点明细!D2', '\'=SUMIF(源数据!K:K,B2,源数据!M:M)']
]);

export const exportInventoryWorkbook = (inventoryImport) => {
  const wb = XLSX.utils.book_new();

  const detailAoA = [
    ['序号', '产品名称', '规格', '面积'],
    ...inventoryImport.groupedRows.map((row) => [row.sequence, row.productName, row.spec, row.area])
  ];
  const detailSheet = XLSX.utils.aoa_to_sheet(detailAoA);
  detailSheet['!cols'] = [{ wch: 8 }, { wch: 38 }, { wch: 70 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, detailSheet, '盘点明细');

  const cleanAoA = [
    ['源行号', '产品名称', '规格', '面积', '厚度', '颜色', '材料/产品名称', '克重下限', '克重上限', '宽度', '长度', '卷数', '异常提示'],
    ...inventoryImport.cleanRows.map((row) => [
      row.sourceRowNumber,
      row.productName,
      row.spec,
      row.area ?? '',
      row.thickness,
      row.color,
      row.material,
      row.weightMin,
      row.weightMax,
      row.width,
      row.length,
      row.rollCount,
      row.errorText
    ])
  ];
  const cleanSheet = XLSX.utils.aoa_to_sheet(cleanAoA);
  cleanSheet['!cols'] = [
    { wch: 8 }, { wch: 38 }, { wch: 55 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 24 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 30 }
  ];
  XLSX.utils.book_append_sheet(wb, cleanSheet, '清洗明细');

  const formulaSheet = XLSX.utils.aoa_to_sheet(formulaRows());
  formulaSheet['!cols'] = [{ wch: 34 }, { wch: 20 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, formulaSheet, '公式参考');

  return wb;
};

export const makeInventoryFileName = () => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `盘点明细_${yyyy}${mm}${dd}.xlsx`;
};
