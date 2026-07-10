import { z } from "zod";
import type { SkillContext, ToolDef } from "../../services/skillTypes.js";

type GeoResult = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  admin2?: string;
  timezone?: string;
};

type ForecastResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
};

const KNOWN_LOCATIONS: Record<string, GeoResult> = {
  怀远: {
    name: "怀远县",
    latitude: 32.9706,
    longitude: 117.2058,
    country: "中国",
    admin1: "安徽",
    admin2: "蚌埠市",
    timezone: "Asia/Shanghai"
  },
  怀远县: {
    name: "怀远县",
    latitude: 32.9706,
    longitude: 117.2058,
    country: "中国",
    admin1: "安徽",
    admin2: "蚌埠市",
    timezone: "Asia/Shanghai"
  }
};

export const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询指定城市实时天气和未来 3 天天气预报。",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "城市、区县或地点名称，例如 北京、上海、怀远、深圳"
          },
          days: {
            type: "number",
            description: "预报天数，默认 3，范围 1-7"
          }
        },
        required: ["city"],
        additionalProperties: false
      }
    }
  }
];

export async function execute(toolName: string, args: Record<string, unknown>, _context: SkillContext) {
  if (toolName !== "get_weather") {
    return { content: `未知工具：${toolName}` };
  }

  const payload = z
    .object({
      city: z.string().min(1),
      days: z.number().int().min(1).max(7).optional()
    })
    .parse(args);

  const city = payload.city.trim();
  const location = await resolveLocation(city);
  if (!location) {
    return {
      content: `我没有找到“${city}”的天气位置。你可以补充省份或城市，例如“安徽怀远”或“广东深圳”。`
    };
  }

  const forecast = await fetchForecast(location, payload.days || 3);
  return {
    content: formatWeatherReply(location, forecast)
  };
}

async function resolveLocation(city: string): Promise<GeoResult | null> {
  const normalized = city.replace(/\s+/g, "").replace(/天气|预报/g, "");
  const known = KNOWN_LOCATIONS[normalized];
  if (known) {
    return known;
  }

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", normalized);
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`天气地理编码失败：${response.status}`);
  }
  const data = (await response.json()) as { results?: GeoResult[] };
  const results = data.results || [];
  if (!results.length) {
    return null;
  }
  return chooseBestLocation(normalized, results);
}

function chooseBestLocation(city: string, results: GeoResult[]) {
  const chinaResults = results.filter((item) => item.country === "中国");
  const pool = chinaResults.length ? chinaResults : results;
  return (
    pool.find((item) => item.name === city) ||
    pool.find((item) => `${item.admin1 || ""}${item.admin2 || ""}${item.name}`.includes(city)) ||
    pool[0]
  );
}

async function fetchForecast(location: GeoResult, days: number): Promise<ForecastResponse> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m"
  );
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  url.searchParams.set("timezone", location.timezone || "Asia/Shanghai");
  url.searchParams.set("forecast_days", String(days));

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`天气查询失败：${response.status}`);
  }
  return (await response.json()) as ForecastResponse;
}

function formatWeatherReply(location: GeoResult, forecast: ForecastResponse) {
  const place = [location.admin1, location.admin2, location.name].filter(Boolean).join(" ");
  const current = forecast.current;
  const lines = [`${place}天气：`];

  if (current) {
    lines.push(
      `现在：${weatherText(current.weather_code)}，${formatNumber(current.temperature_2m)}°C，体感 ${formatNumber(
        current.apparent_temperature
      )}°C，湿度 ${formatNumber(current.relative_humidity_2m)}%，风速 ${formatNumber(current.wind_speed_10m)} km/h。`
    );
  }

  const daily = forecast.daily;
  if (daily?.time?.length) {
    lines.push("未来预报：");
    for (let index = 0; index < daily.time.length; index += 1) {
      lines.push(
        `${daily.time[index]}：${weatherText(daily.weather_code?.[index])}，${formatNumber(
          daily.temperature_2m_min?.[index]
        )}-${formatNumber(daily.temperature_2m_max?.[index])}°C，降雨概率 ${formatNumber(
          daily.precipitation_probability_max?.[index]
        )}%。`
      );
    }
  }

  return lines.join("\n");
}

function weatherText(code?: number) {
  if (code === undefined) {
    return "天气未知";
  }
  if (code === 0) return "晴";
  if ([1, 2, 3].includes(code)) return "多云";
  if ([45, 48].includes(code)) return "有雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "降雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "降雪";
  if ([95, 96, 99].includes(code)) return "雷阵雨";
  return "天气变化";
}

function formatNumber(value?: number) {
  if (value === undefined || Number.isNaN(value)) {
    return "--";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
