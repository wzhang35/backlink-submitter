export const BUSINESS_STATUSES = ['待提交', '待核验', '已验证：未找到记录', '已验证：nolink', '已验证：nofollow', '已验证：dofollow', '受阻：需换链/付费', '受阻：人工处理', '受阻：暂缓（需内容/运营）', '终止：网站失效', '终止：不适合提交'];
export const CATEGORIES = ['综合目录', '创业目录', '软件目录', 'AI工具目录', '开发者平台', '媒体资讯', 'Newsletter', '推广服务', '其他'];
export const LINK_TYPES = ['dofollow', 'nofollow', 'nolink'];
const options = names => names.map(name => ({name}));
const text = (name, description, type = 'plain') => ({name, type:'text', style:{type}, default_value:null, description});
const number = (name, description, precision) => ({name, type:'number', style:{type:'plain',precision,percentage:false,thousands_separator:false}, default_value:null, description});

export function baseFields({defaultSubmitter} = {}) {
  return [
    text('name', '候选站点或目录名称；record_id为稳定记录标识。'),
    text('URL', '候选站点地址，用于本项目查重；不是产品官网或公开收录页。', 'url'),
    {name:'category',type:'select',multiple:false,options:options(CATEGORIES),default_value:null,description:'候选渠道的主要业务类型。'},
    {name:'status',type:'select',multiple:false,options:options(BUSINESS_STATUSES),default_value:['待提交'],description:'业务处理状态；提交回执不等于公开收录，未找到记录不证明绝无收录。'},
    {name:'Submitter',type:'select',multiple:true,options:options(defaultSubmitter ? [defaultSubmitter] : []),default_value:null,description:'实际或历史经办人，可多选；各项目自行维护选项。'},
    {name:'date',type:'datetime',style:{format:'yyyy-MM-dd'},default_value:null,description:'原归档日期；导入留空，提交和审计不改写。'},
    {name:'月份',type:'formula',expression:'IF(ISBLANK([date]),"",TEXT([date],"YYYY-MM"))',description:'由归档日期计算月份。'},
    {name:'Last modified',type:'updated_at',style:{format:'yyyy/MM/dd'},description:'系统最近修改时间，不代表核验完成时间。'},
    text('submit_url', '已核实的表单、编辑、管理或原申请入口；不填登录页。', 'url'),
    text('myurl', '已核验的准确公开收录页；回执、私有编辑页和未核实候选地址只写notes。', 'url'),
    {name:'link_type',type:'select',multiple:false,options:options(LINK_TYPES),default_value:null,description:'公开页原锚点属性；未核实留空，nolink表示资料页存在但未确认官网外链。'},
    number('DR', '目标域名第三方权重0–100；未知留空，0是有效值，默认保留历史指标。', 0),
    number('Traffic (k)', '第三方估算月总访问量，单位千次；不是自然搜索流量，未知留空。', 1),
    {name:'cost',type:'number',style:{type:'currency',currency_code:'USD',precision:1},default_value:null,description:'收录费用USD，免费记0，未知留空；周期与是否付款写notes。'},
    {name:'ROI',type:'formula',expression:'IF(OR(ISBLANK([DR]),ISBLANK([Traffic (k)])),"",100*(0.3*1/(1+POWER(2.718,-0.15*([DR]-45)))+0.7*[Traffic (k)]/([Traffic (k)]+100))/(IF(ISBLANK([cost]),0,[cost])+1.0))',description:'候选粗筛参考分，不是实际投资回报；未知费用仅在计算中暂按0。'},
    text('notes', '人工审阅的完整业务摘要；保留有效回执/编辑链接、限制和待办，不粘贴执行流水。'),
  ];
}

export const BUSINESS_SCHEMA = Object.fromEntries(baseFields().map(({name,type}) => [name,type]));

// Descriptions, colors, and display precision may vary; business semantics must match.
export function compareBaseSchema(actualFields, config = {}) {
  const errors = [], warnings = [], seen = new Map();
  for (const raw of actualFields) {
    const field = raw.field || raw;
    const name = field.name || field.field_name;
    if (seen.has(name)) errors.push(`Duplicate field: ${name}`);
    seen.set(name, field);
  }
  for (const expected of baseFields(config)) {
    const actual = seen.get(expected.name);
    if (!actual) { errors.push(`Missing business field: ${expected.name}`); continue; }
    if (actual.type !== expected.type) { errors.push(`Field ${expected.name} has type=${actual.type}; expected ${expected.type}`); continue; }
    if (actual.type === 'select') {
      if (Boolean(actual.multiple) !== expected.multiple) errors.push(`Field ${expected.name}: multiple must be ${expected.multiple}`);
      if (actual.dynamic_options_source) errors.push(`Field ${expected.name}: static options required`);
      const names = (actual.options || []).map(o => o.name);
      const missing = expected.options.map(o => o.name).filter(name => !names.includes(name));
      if (missing.length) errors.push(`Field ${expected.name} missing options: ${missing.join(', ')}`);
      if (expected.name !== 'Submitter') {
        const extra = names.filter(name => !expected.options.some(o => o.name === name));
        if (extra.length) errors.push(`Field ${expected.name} unexpected options: ${extra.join(', ')}`);
      }
    }
    if (Object.hasOwn(expected,'default_value') && JSON.stringify(actual.default_value ?? null) !== JSON.stringify(expected.default_value)) errors.push(`Field ${expected.name}: default_value must be ${JSON.stringify(expected.default_value)}`);
    if (expected.expression && String(actual.expression || '').trim() !== expected.expression) errors.push(`Field ${expected.name}: formula differs from standard`);
    if (expected.style?.type && actual.style?.type !== expected.style.type) errors.push(`Field ${expected.name}: style.type must be ${expected.style.type}`);
    if (expected.style?.currency_code && actual.style?.currency_code !== expected.style.currency_code) errors.push(`Field ${expected.name}: currency must be ${expected.style.currency_code}`);
    if (actual.type === 'number' && (actual.style?.percentage || actual.style?.decimal)) errors.push(`Field ${expected.name}: percentage display is not supported`);
    if (!actual.description) warnings.push(`Field ${expected.name}: description is empty`);
  }
  for (const name of seen.keys()) if (!Object.hasOwn(BUSINESS_SCHEMA,name)) errors.push(`Unexpected business field: ${name}`);
  return {ok:errors.length === 0, errors, warnings};
}
