import { Markup } from "telegraf";

export const PROMPT_BUTTON_LABEL = "Prompt";
export const IMAGE_BUTTON_LABEL = "Image";

export const promptMenu = Markup.keyboard([[PROMPT_BUTTON_LABEL, IMAGE_BUTTON_LABEL]]).resize();
