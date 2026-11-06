const origin = 'https://abiear.ru';
const localized = (en, ru) => ({ en, ru });
const source = (en, ru) => localized(`${origin}/${en}/`, `${origin}/ru/${ru}/`);
const section = (enTitle, ruTitle, enBody, ruBody) => ({
  title: localized(enTitle, ruTitle),
  body: localized(enBody, ruBody),
});

export const modeLabels = {
  normal: localized('Normal', 'Белая'),
  lockdown: localized('Lockdown', 'Жёлтая'),
  infection: localized('Infection', 'Жёлтая'),
  'severe-infection': localized('Severe Infection', 'Красная'),
  forbidden: localized('Forbidden', 'Красная'),
};

function map(id, enName, ruName, modes, width, height, points) {
  const multiple = points.length > 1;
  return {
    id,
    name: localized(enName, ruName),
    modes,
    source: source(`field-merchant/${id}`, `torgovec/${id}`),
    locations: {
      image: `${origin}/img/site/maps/${id}.webp`,
      width,
      height,
      points,
      caption: localized(
        multiple ? 'The merchant can appear at either marked location.' : 'The merchant appears at the marked location.',
        multiple ? 'Торговец может появиться в одной из двух отмеченных точек.' : 'Торговец появляется в отмеченной точке.',
      ),
    },
  };
}

export const maps = [
  map('farm', 'Farm', 'Ферма', ['normal', 'lockdown', 'severe-infection'], 1600, 781, [[33.93, 31.33], [56.72, 66.44]]),
  map('valley', 'Valley', 'Долина', ['normal', 'infection'], 1600, 705, [[42.88, 49.75], [61.32, 55.44]]),
  map('northridge', 'Northridge', 'Нортридж', ['lockdown', 'forbidden'], 1600, 976, [[36.19, 39.22], [63.80, 58.30]]),
  map('armory', 'Armory', 'Арсенал', ['lockdown', 'forbidden'], 1600, 755, [[52.05, 36.44]]),
  map('tvstation', 'TV Station', 'Телецентр', ['lockdown', 'forbidden'], 1600, 1688, [[10.75, 85.66]]),
  map('airport', 'Airport', 'Аэропорт', ['lockdown', 'severe-infection'], 1600, 1651, [[87.01, 33.49], [23.92, 36.62]]),
];

export const guides = [
  {
    id: 'field-merchant',
    title: localized('Field Merchant guide', 'Гайд по полевому торговцу'),
    summary: localized(
      'Where the merchant appears and what to check before buying cargo.',
      'Где появляется торговец и что стоит проверить перед покупкой груза.',
    ),
    sections: [
      section('Find the merchant', 'Где искать торговца',
        'The Field Merchant can appear on any of the six maps in the modes listed under Maps.',
        'Полевой торговец встречается на всех шести картах в режимах, перечисленных в разделе «Карты».'),
      section('Discounts and purchase limits', 'Скидки и лимиты',
        'Look for a crossed-out original price. Discounts are 10% or 20%. Each raid allows either two or four cargo purchases, regardless of the discount. Use the cart to buy multiple cargos together.',
        'Зачёркнутая цена показывает стоимость без скидки. Скидка составляет 10% или 20%. За рейд можно купить два или четыре груза независимо от скидки. Несколько грузов можно оформить через корзину.'),
      section('Read the cargo', 'Что находится в грузе',
        'In the game, the cargo type and listed price are visible up front. The item is revealed after purchase. The audio cue can be used to estimate the contents before committing Koen.',
        'До покупки игра показывает тип и цену груза. Сам предмет открывается после оплаты. Звук груза можно использовать, чтобы оценить содержимое до траты коэнов.'),
    ],
    source: source('field-merchant-guide', 'gajd-po-torgovcu'),
  },
  {
    id: 'locations',
    title: localized('Find the Field Merchant', 'Как найти полевого торговца'),
    summary: localized('Merchant spawn points on all six maps.', 'Точки появления торговца на всех шести картах.'),
    sections: [
      section('Check your raid map', 'Выберите карту рейда',
        'Open your current raid map in Maps and check the markers. Farm, Valley, Northridge, and Airport each have two possible points. Armory and TV Station each have one.',
        'Откройте карту текущего рейда в разделе «Карты» и проверьте отметки. На Ферме, в Долине, на Нортридже и в Аэропорту по две возможные точки. На Арсенале и Телецентре по одной.'),
      section('Check the mode', 'Проверьте режим',
        'Use the modes listed for your map. The same cargo type can have a different item pool in a different map or mode.',
        'Сверьтесь со списком режимов для вашей карты. Груз одного типа может содержать разные предметы в зависимости от карты и режима.'),
    ],
    source: source('how-to-find-field-merchant', 'kak-najti-torgovca'),
  },
  {
    id: 'red-items',
    title: localized('Find red items', 'Как найти красное у торговца'),
    summary: localized('What affects rare loot and how its value is calculated.', 'Что влияет на редкий лут и как оценивается его стоимость.'),
    sections: [
      section('What affects the odds', 'От чего зависит шанс',
        'The item pool is specific to the map and difficulty. Cargo type and price narrow down the possibilities further.',
        'Набор предметов зависит от карты и сложности. Тип и цена груза дополнительно сужают список возможных находок.'),
      section('Listen before buying', 'Прослушайте груз до покупки',
        'Set the same map and mode as your raid. Hover over the cargo, wait for the price to appear, then drag and drop it once so the audio cue is clear.',
        'Укажите карту и режим рейда. Наведите курсор на груз, дождитесь появления цены, затем один раз перетащите и отпустите груз, чтобы звук был отчётливым.'),
      section('Value and payback', 'Цена и окупаемость',
        'Red items use fixed values that can change with game updates. The market price for gold and lower-tier items fluctuates. Compare the expected value with the actual purchase price, including discounts.',
        'У красных предметов фиксированная стоимость, которая может меняться с обновлениями. Рыночные цены на золотые предметы и предметы более низкого уровня колеблются. Сравнивайте ожидаемую стоимость с фактической ценой покупки с учётом скидки.'),
    ],
    source: source('red-items-field-merchant', 'krasnoe-u-torgovca'),
  },
];
