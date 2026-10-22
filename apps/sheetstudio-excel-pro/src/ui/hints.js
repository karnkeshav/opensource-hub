// name|syntax|description  (shown in autocomplete and the Insert Function dialog)
const RAW = `SUM|number1, [number2], …|Adds numbers
AVERAGE|number1, [number2], …|Mean of numbers
MIN|number1, …|Smallest number
MAX|number1, …|Largest number
COUNT|value1, …|Counts numbers
COUNTA|value1, …|Counts non-empty cells
COUNTBLANK|range|Counts empty cells
COUNTIF|range, criteria|Counts cells that match
COUNTIFS|range1, criteria1, …|Counts cells matching all criteria
SUMIF|range, criteria, [sum_range]|Adds cells that match
SUMIFS|sum_range, range1, criteria1, …|Adds cells matching all criteria
AVERAGEIF|range, criteria, [avg_range]|Mean of matching cells
AVERAGEIFS|avg_range, range1, criteria1, …|Mean of cells matching all criteria
MAXIFS|max_range, range1, criteria1, …|Largest matching value
MINIFS|min_range, range1, criteria1, …|Smallest matching value
SUMPRODUCT|array1, [array2], …|Sum of products
SUBTOTAL|function_num, ref1, …|Subtotal that skips filtered rows
ROUND|number, digits|Rounds to digits
ROUNDUP|number, digits|Rounds away from zero
ROUNDDOWN|number, digits|Rounds toward zero
INT|number|Rounds down to an integer
MOD|number, divisor|Remainder after division
ABS|number|Absolute value
SQRT|number|Square root
POWER|number, power|Raises to a power
LOG|number, [base]|Logarithm
LN|number|Natural logarithm
EXP|number|e raised to a power
RAND|)|Random number from 0 to 1
RANDBETWEEN|bottom, top|Random integer in a range
CEILING|number, significance|Rounds up to a multiple
FLOOR|number, significance|Rounds down to a multiple
MROUND|number, multiple|Rounds to a multiple
MEDIAN|number1, …|Middle value
MODE|number1, …|Most common value
STDEV.S|number1, …|Sample standard deviation
STDEV.P|number1, …|Population standard deviation
VAR.S|number1, …|Sample variance
LARGE|array, k|k-th largest value
SMALL|array, k|k-th smallest value
RANK|number, ref, [order]|Rank of a number in a list
PERCENTILE|array, k|k-th percentile
QUARTILE|array, quart|Quartile of a data set
CORREL|array1, array2|Correlation coefficient
SLOPE|known_y, known_x|Slope of the regression line
INTERCEPT|known_y, known_x|Intercept of the regression line
FORECAST|x, known_y, known_x|Predicts a value on a linear trend
IF|logical_test, value_if_true, [value_if_false]|Chooses between two results
IFS|test1, value1, …|First matching test wins
SWITCH|expression, value1, result1, …, [default]|Matches a value to a result
IFERROR|value, value_if_error|Replaces errors
IFNA|value, value_if_na|Replaces #N/A
AND|logical1, …|TRUE if all are true
OR|logical1, …|TRUE if any is true
NOT|logical|Reverses TRUE/FALSE
XOR|logical1, …|TRUE if an odd number are true
VLOOKUP|lookup_value, table, col_index, [exact]|Looks up a value in the first column
HLOOKUP|lookup_value, table, row_index, [exact]|Looks up a value in the first row
XLOOKUP|lookup, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]|Modern lookup in any direction
MATCH|lookup_value, array, [match_type]|Position of a value
XMATCH|lookup, array, [match_mode], [search_mode]|Position of a value (modern)
INDEX|array, row, [col]|Value (or reference) at a position
LOOKUP|lookup_value, lookup_vector, [result_vector]|Vector lookup
CHOOSE|index, value1, …|Picks a value by index
OFFSET|reference, rows, cols, [height], [width]|Reference moved by rows/columns
INDIRECT|ref_text|Reference from text
ROW|[reference]|Row number
COLUMN|[reference]|Column number
ROWS|array|Number of rows
COLUMNS|array|Number of columns
ADDRESS|row, column, [abs], [a1], [sheet]|Cell address as text
LEN|text|Number of characters
LEFT|text, [chars]|First characters
RIGHT|text, [chars]|Last characters
MID|text, start, chars|Characters from the middle
UPPER|text|Upper case
LOWER|text|Lower case
PROPER|text|Capitalise each word
TRIM|text|Removes extra spaces
CONCAT|text1, …|Joins text (ranges allowed)
CONCATENATE|text1, …|Joins text
TEXTJOIN|delimiter, ignore_empty, text1, …|Joins text with a delimiter
FIND|find, within, [start]|Position of text (case-sensitive)
SEARCH|find, within, [start]|Position of text (wildcards)
SUBSTITUTE|text, old, new, [instance]|Replaces text
REPLACE|text, start, chars, new|Replaces by position
REPT|text, times|Repeats text
TEXT|value, format|Formats a number as text
VALUE|text|Converts text to a number
TEXTBEFORE|text, delimiter, [instance], …|Text before a delimiter
TEXTAFTER|text, delimiter, [instance], …|Text after a delimiter
TEXTSPLIT|text, col_delim, [row_delim], [ignore_empty]|Splits text into an array
REGEXTEST|text, pattern, [case]|TRUE if text matches a regular expression
REGEXEXTRACT|text, pattern, [mode], [case]|Extracts text matching a regular expression
REGEXREPLACE|text, pattern, replacement, [occurrence], [case]|Replaces using a regular expression
TODAY|)|Current date
NOW|)|Current date and time
DATE|year, month, day|Builds a date
YEAR|date|Year of a date
MONTH|date|Month of a date
DAY|date|Day of a date
WEEKDAY|date, [type]|Day of the week
WEEKNUM|date, [type]|Week number
EDATE|start, months|Date months away
EOMONTH|start, months|End of the month
DATEDIF|start, end, unit|Difference between dates (Y, M, D, YM, MD, YD)
NETWORKDAYS|start, end, [holidays]|Working days between dates
WORKDAY|start, days, [holidays]|Date after working days
DAYS|end, start|Days between dates
YEARFRAC|start, end, [basis]|Fraction of a year
HOUR|time|Hour of a time
MINUTE|time|Minute of a time
SECOND|time|Second of a time
PMT|rate, nper, pv, [fv], [type]|Loan payment
FV|rate, nper, pmt, [pv], [type]|Future value
PV|rate, nper, pmt, [fv], [type]|Present value
NPER|rate, pmt, pv, [fv], [type]|Number of periods
RATE|nper, pmt, pv, [fv], [type], [guess]|Interest rate per period
NPV|rate, value1, …|Net present value
IRR|values, [guess]|Internal rate of return
XNPV|rate, values, dates|Net present value with dates
XIRR|values, dates, [guess]|Internal rate of return with dates
IPMT|rate, per, nper, pv, [fv], [type]|Interest part of a payment
PPMT|rate, per, nper, pv, [fv], [type]|Principal part of a payment
SORT|array, [sort_index], [order], [by_col]|Sorts a range (spills)
SORTBY|array, by_array1, [order1], …|Sorts by another range (spills)
FILTER|array, include, [if_empty]|Rows that meet a condition (spills)
UNIQUE|array, [by_col], [exactly_once]|Unique rows (spills)
SEQUENCE|rows, [cols], [start], [step]|Series of numbers (spills)
RANDARRAY|[rows], [cols], [min], [max], [integer]|Random numbers (spills)
TRANSPOSE|array|Swaps rows and columns
VSTACK|array1, …|Stacks arrays vertically
HSTACK|array1, …|Stacks arrays horizontally
TAKE|array, rows, [cols]|First or last rows/columns
DROP|array, rows, [cols]|Removes rows/columns
TOCOL|array, [ignore], [scan_by_col]|Array to one column
TOROW|array, [ignore], [scan_by_col]|Array to one row
CHOOSECOLS|array, col1, …|Picks columns
CHOOSEROWS|array, row1, …|Picks rows
MMULT|array1, array2|Matrix product
MINVERSE|array|Matrix inverse
MDETERM|array|Matrix determinant
LET|name1, value1, …, calculation|Names intermediate results
LAMBDA|param1, …, calculation|Creates a custom function
MAP|array1, …, lambda|Applies a lambda to each element
REDUCE|initial, array, lambda|Folds an array into one value
SCAN|initial, array, lambda|Running fold of an array
BYROW|array, lambda|Applies a lambda to each row
BYCOL|array, lambda|Applies a lambda to each column
MAKEARRAY|rows, cols, lambda|Builds an array from a lambda
GROUPBY|row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array]|Groups rows and summarises values (spills)
PIVOTBY|row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array]|Live pivot table (spills)
SPARKLINE|data, [type]|Tiny chart in the cell: "line", "column" or "winloss"
ISNUMBER|value|TRUE if a number
ISTEXT|value|TRUE if text
ISBLANK|value|TRUE if empty
ISERROR|value|TRUE if any error
ISNA|value|TRUE if #N/A
NORM.DIST|x, mean, sd, cumulative|Normal distribution
NORM.INV|probability, mean, sd|Inverse normal distribution
NORM.S.DIST|z, [cumulative]|Standard normal distribution
NORM.S.INV|probability|Inverse standard normal`;

export const HINTS = RAW.split('\n').map((l) => { const [n, a, d] = l.split('|'); return { n, a: a === ')' ? '' : a, d }; });
export const HINT = new Map(HINTS.map((h) => [h.n, h]));
